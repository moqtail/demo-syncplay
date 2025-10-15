use std::sync::Arc;
use moqtail::model::{common::tuple::Tuple, data::full_track_name};
use moqtail::model::control::publish_namespace::PublishNamespace;
use moqtail::model::control::control_message::ControlMessage;
use moqtail::model::control::client_setup::ClientSetup;
use moqtail::model::control::constant;
use moqtail::transport::control_stream_handler::ControlStreamHandler;
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
    // Announce namespace
    let my_namespace = Tuple::from_utf8_path("moqtail/demo");
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
    // Listen for fetch messages
    loop {
        let msg = control_stream_handler.next_message().await;
        match msg {
            Ok(ControlMessage::Fetch(fetch)) => {
                info!("Received Fetch message: {:?}", fetch);
                    //TODO: Should be able to use moqpublisher's handle fetch here
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
