// Copyright 2025 The MOQtail Authors
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

use crate::indexer;
use bytes::{Buf, BufMut, Bytes, BytesMut};
use moqtail::model::control::control_message::ControlMessageTrait;
use moqtail::model::control::fetch::Fetch;
use moqtail::model::data::fetch_object::FetchObject;
use serde::Deserialize;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::sync::Arc;

//TODO: should be moved to moqtail-rs structure
#[derive(Deserialize)]
pub struct RangeQuery {
    #[serde(rename = "StartGroupId")]
    pub start_group_id: u64,
    #[serde(rename = "StartObjectId")]
    pub start_object_id: u32,
    #[serde(rename = "EndGroupId")]
    pub end_group_id: u64,
    #[serde(rename = "EndObjectId")]
    pub end_object_id: u32,
}

//TODO: Should be moved to moqtail answer
pub async fn handle_range_request(
    query: RangeQuery,
    mp4_path: Arc<String>,
    idx: Arc<indexer::Mp4Index>,
) -> Result<impl warp::Reply, warp::Rejection> {
    println!(
        "GET range: group {}:{} → {}:{}",
        query.start_group_id, query.start_object_id, query.end_group_id, query.end_object_id
    );

    let mut file = File::open(&*mp4_path).unwrap();
    let mut response_bytes = Vec::new();

    // Append init segment
    let init_len = (idx.init.end - idx.init.start) as usize;
    let mut init_buf = vec![0u8; init_len];
    file.seek(SeekFrom::Start(idx.init.start)).unwrap();
    file.read_exact(&mut init_buf).unwrap();
    response_bytes.extend(init_buf);

    // Append requested fragments
    for frag in &idx.frags {
        let in_range = if query.start_group_id == query.end_group_id {
            frag.group == query.start_group_id
                && frag.object >= query.start_object_id
                && frag.object <= query.end_object_id
        } else {
            (frag.group == query.start_group_id && frag.object >= query.start_object_id)
                || (frag.group > query.start_group_id && frag.group < query.end_group_id)
                || (frag.group == query.end_group_id && frag.object <= query.end_object_id)
        };

        if in_range {
            let moof_size = frag.mdat_start - frag.moof_start;
            let total_size = moof_size + frag.mdat_size;
            let mut frag_buf = vec![0u8; total_size as usize];
            file.seek(SeekFrom::Start(frag.moof_start)).unwrap();
            file.read_exact(&mut frag_buf).unwrap();
            response_bytes.extend(frag_buf);
        }
    }

    Ok(warp::reply::with_header(
        response_bytes,
        "Content-Type",
        "video/mp4",
    ))
}

//TODO: Should be moved to moqtail answer
pub async fn handle_fetch_request(
    body: Bytes,
    mp4_path: Arc<String>,
    idx: Arc<indexer::Mp4Index>,
) -> Result<Box<dyn warp::Reply>, warp::Rejection> {
    println!("POST fetch request with {} bytes", body.len());

    // Deserialize the Fetch request - the body should contain the full serialized message
    let mut bytes = body;

    // Skip the control message type (1 byte)
    if bytes.is_empty() {
        return Ok(Box::new(warp::reply::with_status(
            "Empty request body".to_string(),
            warp::http::StatusCode::BAD_REQUEST,
        )));
    }
    bytes.advance(1); // Skip message type

    // Skip the payload length (2 bytes)
    if bytes.len() < 2 {
        return Ok(Box::new(warp::reply::with_status(
            "Message too short".to_string(),
            warp::http::StatusCode::BAD_REQUEST,
        )));
    }
    bytes.advance(2); // Skip payload length

    let fetch = match Fetch::parse_payload(&mut bytes) {
        Ok(fetch) => *fetch,
        Err(e) => {
            println!("Failed to parse Fetch request: {:?}", e);
            return Ok(Box::new(warp::reply::with_status(
                format!("Failed to parse Fetch request: {:?}", e),
                warp::http::StatusCode::BAD_REQUEST,
            )));
        }
    };

    println!("Parsed Fetch request: {:?}", fetch);

    // For now, we only support StandAlone fetch requests
    let standalone_props = match &fetch.standalone_fetch_props {
        Some(props) => props,
        None => {
            return Ok(Box::new(warp::reply::with_status(
                "Only StandAlone fetch requests are supported".to_string(),
                warp::http::StatusCode::BAD_REQUEST,
            )));
        }
    };

    // Extract start and end locations
    let start_group = standalone_props.start_location.group;
    let start_object = standalone_props.start_location.object;
    let end_group = standalone_props.end_location.group;
    let end_object = standalone_props.end_location.object;

    println!(
        "Fetch range: group {}:{} → {}:{}",
        start_group, start_object, end_group, end_object
    );

    let mut file = File::open(&*mp4_path).unwrap();
    let mut response_bytes = BytesMut::new();

    // First, serialize and add the init segment as a FetchObject
    let init_len = (idx.init.end - idx.init.start) as usize;
    let mut init_buf = vec![0u8; init_len];
    file.seek(SeekFrom::Start(idx.init.start)).unwrap();
    file.read_exact(&mut init_buf).unwrap();

    let init_fetch_object = FetchObject {
        group_id: 0, // Init segment is typically group 0
        subgroup_id: 0,
        object_id: 0, // Init segment is typically object 0
        publisher_priority: 128,
        extension_headers: None,
        object_status: None,
        payload: Some(Bytes::from(init_buf)),
    };

    match init_fetch_object.serialize() {
        Ok(serialized_init) => {
            // Add length prefix for the init object
            response_bytes.put_u32(serialized_init.len() as u32);
            response_bytes.extend_from_slice(&serialized_init);
        }
        Err(e) => {
            println!("Failed to serialize init FetchObject: {:?}", e);
            return Ok(Box::new(warp::reply::with_status(
                format!("Failed to serialize init FetchObject: {:?}", e),
                warp::http::StatusCode::INTERNAL_SERVER_ERROR,
            )));
        }
    }

    // Now serialize and add requested fragments as FetchObjects
    for frag in &idx.frags {
        let in_range = if start_group == end_group {
            frag.group == start_group
                && frag.object as u64 >= start_object
                && frag.object as u64 <= end_object
        } else {
            (frag.group == start_group && frag.object as u64 >= start_object)
                || (frag.group > start_group && frag.group < end_group)
                || (frag.group == end_group && frag.object as u64 <= end_object)
        };

        if in_range {
            let moof_size = frag.mdat_start - frag.moof_start;
            let total_size = moof_size + frag.mdat_size;
            let mut frag_buf = vec![0u8; total_size as usize];
            file.seek(SeekFrom::Start(frag.moof_start)).unwrap();
            file.read_exact(&mut frag_buf).unwrap();

            let frag_fetch_object = FetchObject {
                group_id: frag.group,
                subgroup_id: 0, // Assuming subgroup 0 for simplicity
                object_id: frag.object as u64,
                publisher_priority: 128,
                extension_headers: None,
                object_status: None,
                payload: Some(Bytes::from(frag_buf)),
            };

            match frag_fetch_object.serialize() {
                Ok(serialized_frag) => {
                    // Add length prefix for each fragment object
                    response_bytes.put_u32(serialized_frag.len() as u32);
                    response_bytes.extend_from_slice(&serialized_frag);
                }
                Err(e) => {
                    println!("Failed to serialize fragment FetchObject: {:?}", e);
                    return Ok(Box::new(warp::reply::with_status(
                        format!("Failed to serialize fragment FetchObject: {:?}", e),
                        warp::http::StatusCode::INTERNAL_SERVER_ERROR,
                    )));
                }
            }
        }
    }

    println!(
        "Sending {} bytes of serialized FetchObjects",
        response_bytes.len()
    );

    Ok(Box::new(warp::reply::with_header(
        response_bytes.into_iter().collect::<Vec<u8>>(),
        "Content-Type",
        "application/octet-stream",
    )))
}
