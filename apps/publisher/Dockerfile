FROM rust:alpine

WORKDIR /usr/src/app

RUN apk add --no-cache musl-dev openssl-dev

COPY . .

RUN cargo build --release

CMD ["./target/release/publisher", "source.mp4"]