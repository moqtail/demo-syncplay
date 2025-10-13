mod moqpublisher;
mod indexer;
use std::sync::Arc;
use warp::Filter;


#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let path = std::env::args().nth(1).expect("usage: idx <file>");
    let idx = indexer::build_index(&path)?;
    //println!("Indexed {} fragments", idx.frags.len());

    let mp4_path = Arc::new(path);
    let idx = Arc::new(idx);

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
