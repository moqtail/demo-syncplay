use std::sync::Arc;
use moqtail::model::{
    common::tuple::Tuple,
    data::subgroup_object::SubgroupObject,
    data::object::Object,
};
use bytes::Bytes;
use std::io::{Read, Seek, SeekFrom};
use moqtail::model::control::publish_namespace::PublishNamespace;
use moqtail::model::control::subscribe_ok::SubscribeOk;
use moqtail::model::control::control_message::ControlMessage;
use moqtail::model::control::client_setup::ClientSetup;
use moqtail::model::control::constant;
use moqtail::transport::control_stream_handler::ControlStreamHandler;
use moqtail::transport::data_stream_handler::{HeaderInfo, SendDataStream};
use moqtail::model::data::subgroup_header::SubgroupHeader;
use tracing::{info, error};
use wtransport::{ClientConfig, Endpoint};
use crate::indexer;

pub async fn run_moq_publisher(mp4_path: Arc<String>, idx: Arc<indexer::Mp4Index>) -> Result<(), anyhow::Error> {
    let endpoint = "https://localhost:4433";
    let validate_cert = true;
    let c = ClientConfig::builder().with_bind_default();
    let config = if validate_cert {
        c.with_no_cert_validation().build()
    } else {
        c.with_native_certs().build()
    };
    let connection = Arc::new(
        Endpoint::client(config)
            .unwrap()
            .connect(endpoint)
            .await
            .unwrap(),
    );
    let (send_stream, recv_stream) = connection.open_bi().await.unwrap().await.unwrap();
    let mut control_stream_handler = ControlStreamHandler::new(send_stream, recv_stream);
    let client_setup = ClientSetup::new([constant::DRAFT_14].to_vec(), [].to_vec());
    match control_stream_handler.send_impl(&client_setup).await {
        Ok(_) => info!("Client setup sent successfully"),
        Err(e) => error!("Failed to send client setup: {:?}", e),
    }
    let server_setup = match control_stream_handler.next_message().await {
        Ok(ControlMessage::ServerSetup(m)) => m,
        Ok(m) => {
            error!("Unexpected message type: {:?}", m);
            return Err(anyhow::anyhow!("Unexpected message type: {:?}", m));
        }
        Err(e) => {
            error!("Failed to receive server setup: {:?}", e);
            return Err(anyhow::anyhow!("Failed to receive server setup: {:?}", e));
        }
    };
    info!("Received server setup: {:?}", server_setup);
    if server_setup.selected_version != constant::DRAFT_14 {
        error!(
            "Server setup version mismatch: expected {:0X}, got {}",
            constant::DRAFT_14,
            server_setup.selected_version
        );
        return Err(anyhow::anyhow!(
            "Server setup version mismatch: expected {:0X}, got {}",
            constant::DRAFT_14,
            server_setup.selected_version
        ));
    }
    // Announce namespace (only the namespace prefix, not the track name)
    let my_namespace = Tuple::from_utf8_path("moqtail");
    let request_id = 0;
    let announce = PublishNamespace::new(request_id, my_namespace, &[]);
    control_stream_handler.send_impl(&announce).await.unwrap();
    let announce_ok = control_stream_handler.next_message().await;
    match announce_ok {
        Ok(ControlMessage::PublishNamespaceOk(_)) => {
            info!("Received announce ok message");
        }
        Ok(_) => {
            error!("Expecting announce ok message");
            return Err(anyhow::anyhow!("Expecting announce ok message"));
        }
        Err(e) => {
            error!("Failed to receive message: {:?}", e);
            return Err(anyhow::anyhow!("Failed to receive message: {:?}", e));
        }
    }
    info!("PublishNamespace sent successfully");

    // Keep track of which aliases we've started publishing for so we don't spawn duplicate tasks
    let mut published_aliases: std::collections::HashSet<u64> = std::collections::HashSet::new();

    // Listen for control messages and respond to SUBSCRIBE by sending SubscribeOk
    loop {
        let msg = control_stream_handler.next_message().await;
        match msg {
            Ok(ControlMessage::Subscribe(s)) => {
                // s is a Box<Subscribe>
                info!("Received Subscribe message: {:?}", s);
                let sub = *s;

                // choose a track alias for publishing; 1 is fine for a single published track
                let track_alias: u64 = 1;
                let expires: u64 = 0;

                // send SubscribeOk back to relay so it can map alias -> full track name
                let subscribe_ok = SubscribeOk::new_ascending_with_content(
                    sub.request_id,
                    track_alias,
                    expires,
                    None,
                    None,
                );

                if let Err(e) = control_stream_handler.send_impl(&subscribe_ok).await {
                    error!("Failed to send SubscribeOk: {:?}", e);
                    continue;
                }

                info!("SubscribeOk sent for request {} with alias {}", sub.request_id, track_alias);

                // Spawn the proactive publishing task now that alias is registered
                // Avoid spawning multiple publisher tasks for the same alias
                if published_aliases.contains(&track_alias) {
                    info!("Already publishing for alias {}, skipping spawn", track_alias);
                    continue;
                }
                published_aliases.insert(track_alias);

                let conn_clone = connection.clone();
                let mp4_path_clone = mp4_path.clone();
                let idx_clone = idx.clone();
                tokio::spawn(async move {
                    // publisher priority
                    let publisher_priority: u8 = 128;

                    // open the file once
                    let mut file = match std::fs::File::open(&*mp4_path_clone) {
                        Ok(f) => f,
                        Err(e) => {
                            error!("Failed to open mp4 file for publishing: {:?}", e);
                            return;
                        }
                    };

                    // group fragments by group id
                    let mut groups: std::collections::BTreeMap<u64, Vec<_>> = std::collections::BTreeMap::new();
                    for frag in &idx_clone.frags {
                        groups.entry(frag.group).or_default().push(frag.clone());
                    }

                    // Send init segment (ftyp+moov) as group 0 object 0 so subscribers and caches
                    // receive the MP4 initialization segment before any media fragments.
                    // This mirrors the behavior of the HTTP/Fetch handlers which include the init
                    // segment first.
                    let init_len = (idx_clone.init.end - idx_clone.init.start) as usize;
                    if init_len > 0 {
                        let mut init_buf = vec![0u8; init_len];
                        if let Err(e) = file.seek(SeekFrom::Start(idx_clone.init.start)) {
                            error!("Failed to seek to init start: {:?}", e);
                        } else if let Err(e) = file.read_exact(&mut init_buf) {
                            error!("Failed to read init bytes: {:?}", e);
                        } else {
                            // open a unidirectional stream for the init segment
                            let stream_res = conn_clone.open_uni().await;
                            match stream_res {
                                Err(e) => {
                                    error!("Failed to open uni stream for init: {:?}", e);
                                }
                                Ok(pending) => {
                                    match pending.await {
                                        Err(e) => error!("Failed to complete open uni stream for init: {:?}", e),
                                        Ok(send_stream) => {
                                            let send_stream = Arc::new(tokio::sync::Mutex::new(send_stream));

                                            // For the init segment we will publish it as group 0 object 0
                                            // Use explicit subgroup id 0 so receivers know this is the init object
                                            let sub_header = SubgroupHeader::new_with_explicit_id(
                                                track_alias,
                                                0,
                                                0,
                                                publisher_priority,
                                                false,
                                                false,
                                            );

                                            let header_info = HeaderInfo::Subgroup { header: sub_header };
                                            match SendDataStream::new(send_stream.clone(), header_info).await {
                                                Ok(mut stream_handler) => {
                                                    let subgroup_obj = SubgroupObject {
                                                        object_id: 0,
                                                        extension_headers: None,
                                                        object_status: None,
                                                        payload: Some(Bytes::from(init_buf.clone())),
                                                    };

                                                    let object = match Object::try_from_subgroup(
                                                        subgroup_obj,
                                                        track_alias,
                                                        0,
                                                        Some(0),
                                                        publisher_priority,
                                                    ) {
                                                        Ok(o) => o,
                                                        Err(e) => {
                                                            error!("Failed to build init Object from subgroup: {:?}", e);
                                                            // Not inside loop here — skip sending init object.
                                                            // Return early from the spawned task to avoid further errors.
                                                            return;
                                                        }
                                                    };

                                                    if let Err(e) = stream_handler.send_object(&object, None).await {
                                                        error!("Failed to send init object: {:?}", e);
                                                    }

                                                    if let Err(e) = stream_handler.flush().await {
                                                        error!("Failed to flush init stream: {:?}", e);
                                                    }

                                                    if let Err(e) = stream_handler.finish().await {
                                                        error!("Failed to finish init stream: {:?}", e);
                                                    }
                                                    info!("Sent init segment as group 0 object 0 ({} bytes)", init_len);
                                                }
                                                Err(e) => error!("Failed to create SendDataStream for init: {:?}", e),
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }

                    for (group_id, frags) in groups {
                        info!("Publishing group {} with {} fragments (total across tracks)", group_id, frags.len());
                        tokio::time::sleep(std::time::Duration::from_nanos(10)).await;
                        // Partition the fragments for this group by track id so we publish one
                        // unidirectional stream per track (video/audio), which ensures both
                        // tracks' objects are sent (previously only one stream per group was used).
                        let mut per_track: std::collections::BTreeMap<u32, Vec<_>> = std::collections::BTreeMap::new();
                        for frag in frags.iter() {
                            per_track.entry(frag.track_id).or_default().push(frag.clone());
                        }

                        let track_count = per_track.len();
                        for (track_idx, (track_id, track_frags)) in per_track.into_iter().enumerate() {
                            info!("Publishing group {} track {} with {} fragments", group_id, track_id, track_frags.len());

                            // open a unidirectional stream for this track
                            let stream_res = conn_clone.open_uni().await;
                            if let Err(e) = stream_res {
                                error!("Failed to open uni stream for group {} track {}: {:?}", group_id, track_id, e);
                                continue;
                            }
                            let pending = stream_res.unwrap();
                            let open_res = pending.await;
                            if let Err(e) = open_res {
                                error!("Failed to complete open uni stream for group {} track {}: {:?}", group_id, track_id, e);
                                continue;
                            }
                            let send_stream = open_res.unwrap();
                            let send_stream = Arc::new(tokio::sync::Mutex::new(send_stream));

                            // pick subgroup id as first object's id; for our publisher we start objects at 1
                            let first_object_id: u64 = 1;
                            // mark contains_end_of_group = true only for the last track stream
                            let contains_end_of_group = track_idx + 1 == track_count;
                            let sub_header = SubgroupHeader::new_first_object_id(
                                track_alias,
                                group_id,
                                publisher_priority,
                                false,
                                contains_end_of_group,
                            );

                            let header_info = HeaderInfo::Subgroup { header: sub_header };
                            let mut stream_handler = match SendDataStream::new(send_stream.clone(), header_info).await {
                                Ok(s) => s,
                                Err(e) => {
                                    error!("Failed to create SendDataStream for group {} track {}: {:?}", group_id, track_id, e);
                                    continue;
                                }
                            };

                            // send each fragment for this track
                            let mut prev_object_id: Option<u64> = None;
                            for (i, frag) in track_frags.iter().enumerate().take(24) {
                                let object_id_for_frag: u64 = (i as u64) + 1;
                                let moof_size = frag.mdat_start - frag.moof_start;
                                let total_size = moof_size + frag.mdat_size;
                                let mut buf = vec![0u8; total_size as usize];
                                if let Err(e) = file.seek(SeekFrom::Start(frag.moof_start)) {
                                    error!("Failed to seek mp4 file: {:?}", e);
                                    break;
                                }
                                if let Err(e) = file.read_exact(&mut buf) {
                                    error!("Failed to read fragment bytes: {:?}", e);
                                    break;
                                }

                                let subgroup_obj = SubgroupObject {
                                    object_id: object_id_for_frag,
                                    extension_headers: None,
                                    object_status: None,
                                    payload: Some(Bytes::from(buf)),
                                };

                                let object = match Object::try_from_subgroup(
                                    subgroup_obj.clone(),
                                    track_alias,
                                    group_id,
                                    Some(first_object_id),
                                    publisher_priority,
                                ) {
                                    Ok(o) => o,
                                    Err(e) => {
                                        error!("Failed to build Object from subgroup: {:?}", e);
                                        // skip this object
                                        continue;
                                    }
                                };

                                if let Err(e) = stream_handler.send_object(&object, prev_object_id).await {
                                    error!("Failed to send object for group {} track {} object {}: {:?}", group_id, track_id, object_id_for_frag, e);
                                    break;
                                } else {
                                    info!("Sent object for group {} track {} object {} (size={})", group_id, track_id, object_id_for_frag, object.payload.as_ref().map(|p| p.len()).unwrap_or(0));
                                }
                                prev_object_id = Some(object.location.object);
                            }

                            if let Err(e) = stream_handler.flush().await {
                                error!("Failed to flush stream for group {} track {}: {:?}", group_id, track_id, e);
                            }
                            if let Err(e) = stream_handler.finish().await {
                                error!("Failed to finish stream for group {} track {}: {:?}", group_id, track_id, e);
                            }
                        }

                        info!("Finished publishing group {}", group_id);
                    }
                });
            }
            Ok(ControlMessage::Fetch(fetch)) => {
                info!("Received Fetch message: {:?}", fetch);
                // TODO: respond to fetchs via control stream or data streams if desired
            }
            Ok(other) => {
                info!("Received other control message: {:?}", other);
            }
            Err(e) => {
                error!("Error receiving control message: {:?}", e);
                break;
            }
        }
    }
    Ok(())
}
