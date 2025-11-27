FROM rust:bookworm

WORKDIR /usr/src/app

COPY . .

RUN cargo build --release

CMD ["./target/release/publisher", "out_framefrag.mp4"]