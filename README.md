# SyncPlay: Synchronized VoD with MOQ

SyncPlay uses the MOQ protocol to enable **synchronized (time-aligned) video-on-demand (VoD) playback** across geographically dispersed users.

---
## Online Demo
Available at [https://syncplay.moqtail.dev](https://syncplay.moqtail.dev)

## Research Paper
Under review, to be posted soon.

## Run Locally
### Prerequisites

* **Docker**
* **Local Certificates**

### Running the Demo
```bash
# 1. Install the local CA.
mkcert -install

# 2. Generate certificate files for 'localhost', '127.0.0.1', and '::1'.
mkcert -key-file cert/key.pem -cert-file cert/cert.pem localhost 127.0.0.1 ::1

# 3. Run the Docker containers.
docker compose up --build
```

**The app will be available at [http://localhost:15173](http://localhost:15173) by default.**

> [!NOTE]
> If you experience issues with TLS certificates, please check the [README](cert/README.md) in the `cert` directory for troubleshooting steps.
