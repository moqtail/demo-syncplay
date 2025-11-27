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

mod indexer;
mod moq_publisher_client;
mod moqpublisher;
use std::sync::Arc;
use warp::Filter;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let path = std::env::args().nth(1).expect("usage: idx <file>");
    let idx = indexer::build_index(&path)?;
    //println!("Indexed {} fragments", idx.frags.len());

    let mp4_path = Arc::new(path);
    let idx = Arc::new(idx);

    // Start MOQ publisher client in background
    let mp4_path_clone = mp4_path.clone();
    let idx_clone = idx.clone();
    tokio::spawn(async move {
        if let Err(e) = moq_publisher_client::run_moq_publisher(mp4_path_clone, idx_clone).await {
            eprintln!("MOQ publisher client error: {e:?}");
        }
    });

    let mp4_path_filter = warp::any().map({
        let mp4_path = mp4_path.clone();
        move || mp4_path.clone()
    });

    let idx_filter = warp::any().map({
        let idx = idx.clone();
        move || idx.clone()
    });

    let range_route = warp::get()
        .and(warp::path("range"))
        .and(warp::query::<moqpublisher::RangeQuery>())
        .and(mp4_path_filter.clone())
        .and(idx_filter.clone())
        .and_then(moqpublisher::handle_range_request);

    let fetch_route = warp::post()
        .and(warp::path("fetch"))
        .and(warp::body::bytes())
        .and(mp4_path_filter.clone())
        .and(idx_filter.clone())
        .and_then(moqpublisher::handle_fetch_request);

    let cors = warp::cors()
        .allow_any_origin()
        .allow_methods(vec!["GET", "POST"])
        .allow_headers(vec!["content-type"]);

    let routes = range_route.or(fetch_route).with(cors);

    println!("Server: http://localhost:8001");
    warp::serve(routes).run(([127, 0, 0, 1], 8001)).await;
    Ok(())
}
