//! Test-only RTSP server on `127.0.0.1:0`: just enough of RFC 2326 for retina to DESCRIBE (with a
//! Basic challenge), SETUP over TCP interleaved, PLAY and receive one IDR access unit plus a few
//! P-slices. The NAL payloads are hand-written and not decodable; tests assert framing, not
//! pictures. The SPS/PPS in `sprop-parameter-sets` are real (1920x1080, Main 4.2) so retina can
//! build `VideoParameters` (avcC, RFC 6381 codec, dimensions).

use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::task::JoinHandle;

pub const USER: &str = "test_user";
pub const PASS: &str = "test_pw_x";
pub const SPROP: &str = "Z00AKp2oHgCJ+WbgICAoAAADAAgAAAMAfCA=,aO48gA==";
/// RTP timestamp step between access units (30 fps at 90 kHz).
pub const TS_STEP: u32 = 3_000;
const RTP_TS_BASE: u32 = 1_000;
const SSRC: u32 = 0x1234_5678;

#[derive(Clone, Debug)]
pub struct FakeOptions {
    /// SDP encoding name (`H264`, or e.g. `H265` to provoke unsupportedCodec).
    pub encoding: &'static str,
    /// P-slices after the IDR.
    pub deltas: usize,
    /// Connections (by accept index, 0-based) that are closed right after the frames are written,
    /// simulating a dropped stream. Later connections stay open until the client closes them.
    pub drop_connections: usize,
    /// DESCRIBE answers `404 Not Found` (a wrong path).
    pub not_found: bool,
    /// Send a P-slice before the IDR, as a camera joining mid-GOP would.
    pub leading_delta: bool,
}

impl Default for FakeOptions {
    fn default() -> Self {
        Self {
            encoding: "H264",
            deltas: 3,
            drop_connections: 0,
            not_found: false,
            leading_delta: false,
        }
    }
}

pub struct FakeRtsp {
    pub port: u16,
    accepts: Arc<AtomicUsize>,
    /// Connections the CLIENT closed (the server read hit EOF), i.e. the session was dropped.
    closed: Arc<AtomicUsize>,
    teardowns: Arc<AtomicUsize>,
    task: JoinHandle<()>,
}

impl FakeRtsp {
    pub async fn start(options: FakeOptions) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let port = listener.local_addr().expect("addr").port();
        let accepts = Arc::new(AtomicUsize::new(0));
        let counter = Arc::clone(&accepts);
        let closed = Arc::new(AtomicUsize::new(0));
        let teardowns = Arc::new(AtomicUsize::new(0));
        let counters = (Arc::clone(&closed), Arc::clone(&teardowns));
        let options = Arc::new(options);
        let task = tokio::spawn(async move {
            while let Ok((sock, _)) = listener.accept().await {
                let index = counter.fetch_add(1, Ordering::SeqCst);
                let serving = Serving {
                    options: Arc::clone(&options),
                    port,
                    index,
                    closed: Arc::clone(&counters.0),
                    teardowns: Arc::clone(&counters.1),
                };
                tokio::spawn(serve(sock, serving));
            }
        });
        Self {
            port,
            accepts,
            closed,
            teardowns,
            task,
        }
    }

    pub fn url(&self) -> String {
        format!("rtsp://127.0.0.1:{}/ch2", self.port)
    }

    pub fn accepts(&self) -> usize {
        self.accepts.load(Ordering::SeqCst)
    }

    pub fn closed(&self) -> usize {
        self.closed.load(Ordering::SeqCst)
    }

    pub fn teardowns(&self) -> usize {
        self.teardowns.load(Ordering::SeqCst)
    }
}

impl Drop for FakeRtsp {
    fn drop(&mut self) {
        self.task.abort();
    }
}

fn base64(input: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::new();
    for chunk in input.chunks(3) {
        let b = [
            chunk[0],
            *chunk.get(1).unwrap_or(&0),
            *chunk.get(2).unwrap_or(&0),
        ];
        let n = (u32::from(b[0]) << 16) | (u32::from(b[1]) << 8) | u32::from(b[2]);
        for i in 0..4 {
            if i <= chunk.len() {
                out.push(ALPHABET[((n >> (18 - 6 * i)) & 63) as usize] as char);
            } else {
                out.push('=');
            }
        }
    }
    out
}

pub fn basic_auth_header() -> String {
    format!("Basic {}", base64(format!("{USER}:{PASS}").as_bytes()))
}

struct Request {
    method: String,
    cseq: String,
    authorization: Option<String>,
}

/// Reads one RTSP request head, skipping any interleaved `$` data the client sends.
async fn read_request(sock: &mut TcpStream, buf: &mut Vec<u8>) -> Option<Request> {
    loop {
        if buf.first() == Some(&b'$') && buf.len() >= 4 {
            let len = usize::from(u16::from_be_bytes([buf[2], buf[3]]));
            if buf.len() >= 4 + len {
                buf.drain(..4 + len);
                continue;
            }
        } else if let Some(end) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            let head = String::from_utf8_lossy(&buf[..end]).into_owned();
            buf.drain(..end + 4);
            let mut lines = head.lines();
            let method = lines.next()?.split(' ').next()?.to_string();
            let mut cseq = String::from("0");
            let mut authorization = None;
            for line in lines {
                if let Some((name, value)) = line.split_once(':') {
                    match name.trim().to_ascii_lowercase().as_str() {
                        "cseq" => cseq = value.trim().to_string(),
                        "authorization" => authorization = Some(value.trim().to_string()),
                        _ => {}
                    }
                }
            }
            return Some(Request {
                method,
                cseq,
                authorization,
            });
        }
        let mut chunk = [0u8; 2048];
        let n = sock.read(&mut chunk).await.ok()?;
        if n == 0 {
            return None;
        }
        buf.extend_from_slice(&chunk[..n]);
    }
}

fn response(status: &str, cseq: &str, headers: &[String], body: &str) -> Vec<u8> {
    let mut out = format!("RTSP/1.0 {status}\r\nCSeq: {cseq}\r\n");
    for h in headers {
        out.push_str(h);
        out.push_str("\r\n");
    }
    out.push_str(&format!("Content-Length: {}\r\n\r\n{body}", body.len()));
    out.into_bytes()
}

fn sdp(encoding: &str) -> String {
    format!(
        "v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\ns=fake\r\nc=IN IP4 0.0.0.0\r\nt=0 0\r\n\
         m=video 0 RTP/AVP 96\r\na=rtpmap:96 {encoding}/90000\r\n\
         a=fmtp:96 packetization-mode=1;profile-level-id=4D002A;sprop-parameter-sets={SPROP}\r\n\
         a=framerate:15\r\na=control:trackID=1\r\n"
    )
}

/// One interleaved RTP packet (channel 0) carrying a single NAL unit, marker bit set: one AU each.
fn rtp_packet(seq: u16, ts: u32, nal: &[u8]) -> Vec<u8> {
    let mut rtp = vec![0x80, 0x80 | 96];
    rtp.extend_from_slice(&seq.to_be_bytes());
    rtp.extend_from_slice(&ts.to_be_bytes());
    rtp.extend_from_slice(&SSRC.to_be_bytes());
    rtp.extend_from_slice(nal);
    let mut out = vec![b'$', 0];
    out.extend_from_slice(&(rtp.len() as u16).to_be_bytes());
    out.extend_from_slice(&rtp);
    out
}

/// The NAL payloads in send order: IDR (type 5) then `deltas` P-slices (type 1). No payload ends in
/// a zero byte: retina trims trailing zeros (they are not part of the NAL).
pub fn access_units(deltas: usize) -> Vec<Vec<u8>> {
    access_units_from(deltas, false)
}

/// Like `access_units`, optionally led by a P-slice that precedes the first IDR.
pub fn access_units_from(deltas: usize, leading_delta: bool) -> Vec<Vec<u8>> {
    let mut aus = Vec::new();
    if leading_delta {
        aus.push(vec![0x41, 0x9a, 0x7f]);
    }
    aus.push(vec![0x65, 0x88, 0x84, 0x00, 0x10]);
    for i in 0..deltas {
        aus.push(vec![0x41, 0x9a, 0x10 + i as u8]);
    }
    aus
}

/// A listener that accepts and immediately closes every connection: an RTSP endpoint that fails
/// without a status code. (A closed port is no good on Windows: a refused connect takes ~2 s.)
pub async fn closing_listener() -> (u16, JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let port = listener.local_addr().expect("addr").port();
    let task = tokio::spawn(async move {
        while let Ok((sock, _)) = listener.accept().await {
            drop(sock);
        }
    });
    (port, task)
}

struct Serving {
    options: Arc<FakeOptions>,
    port: u16,
    index: usize,
    closed: Arc<AtomicUsize>,
    teardowns: Arc<AtomicUsize>,
}

/// Counts the connection as closed however `serve` returns (EOF, write error, deliberate drop).
struct ClosedOnDrop(Arc<AtomicUsize>);

impl Drop for ClosedOnDrop {
    fn drop(&mut self) {
        self.0.fetch_add(1, Ordering::SeqCst);
    }
}

async fn serve(mut sock: TcpStream, serving: Serving) {
    let Serving {
        options,
        port,
        index,
        closed,
        teardowns,
    } = serving;
    let _closed = ClosedOnDrop(closed);
    let mut buf = Vec::new();
    let session = String::from("Session: 12345678;timeout=60");
    while let Some(req) = read_request(&mut sock, &mut buf).await {
        let reply = match req.method.as_str() {
            "DESCRIBE" if options.not_found => response("404 Not Found", &req.cseq, &[], ""),
            "OPTIONS" => response(
                "200 OK",
                &req.cseq,
                &["Public: OPTIONS, DESCRIBE, SETUP, PLAY, TEARDOWN".into()],
                "",
            ),
            "DESCRIBE" if req.authorization.as_deref() != Some(basic_auth_header().as_str()) => {
                response(
                    "401 Unauthorized",
                    &req.cseq,
                    &["WWW-Authenticate: Basic realm=\"fake\"".into()],
                    "",
                )
            }
            "DESCRIBE" => response(
                "200 OK",
                &req.cseq,
                &[
                    format!("Content-Base: rtsp://127.0.0.1:{port}/ch2/"),
                    "Content-Type: application/sdp".into(),
                ],
                &sdp(options.encoding),
            ),
            "SETUP" => response(
                "200 OK",
                &req.cseq,
                &[
                    session.clone(),
                    "Transport: RTP/AVP/TCP;unicast;interleaved=0-1".into(),
                ],
                "",
            ),
            "PLAY" => {
                let mut out = response("200 OK", &req.cseq, std::slice::from_ref(&session), "");
                let aus = access_units_from(options.deltas, options.leading_delta);
                for (i, nal) in aus.iter().enumerate() {
                    let ts = RTP_TS_BASE + TS_STEP * i as u32;
                    out.extend(rtp_packet(i as u16 + 1, ts, nal));
                }
                if sock.write_all(&out).await.is_err() {
                    return;
                }
                if index < options.drop_connections {
                    return; // dropping the socket closes the connection mid-stream
                }
                continue;
            }
            "TEARDOWN" => {
                teardowns.fetch_add(1, Ordering::SeqCst);
                response("200 OK", &req.cseq, std::slice::from_ref(&session), "")
            }
            _ => response("200 OK", &req.cseq, std::slice::from_ref(&session), ""),
        };
        if sock.write_all(&reply).await.is_err() {
            return;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn exchange(port: u16, request: &str) -> String {
        let mut sock = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        sock.write_all(request.as_bytes()).await.unwrap();
        let mut buf = Vec::new();
        let mut chunk = [0u8; 4096];
        // Read until the advertised body has arrived.
        loop {
            let n = sock.read(&mut chunk).await.unwrap();
            assert!(n > 0, "server closed early");
            buf.extend_from_slice(&chunk[..n]);
            let text = String::from_utf8_lossy(&buf);
            if let Some(end) = text.find("\r\n\r\n") {
                let len: usize = text
                    .lines()
                    .find_map(|l| l.strip_prefix("Content-Length: "))
                    .and_then(|v| v.trim().parse().ok())
                    .unwrap_or(0);
                if buf.len() >= end + 4 + len {
                    return text.into_owned();
                }
            }
        }
    }

    #[test]
    fn base64_matches_known_vectors() {
        assert_eq!(base64(b""), "");
        assert_eq!(base64(b"f"), "Zg==");
        assert_eq!(base64(b"fo"), "Zm8=");
        assert_eq!(base64(b"foo"), "Zm9v");
        assert_eq!(base64(b"foobar"), "Zm9vYmFy");
    }

    #[tokio::test]
    async fn answers_a_raw_describe_with_a_challenge_then_the_sdp() {
        let fake = FakeRtsp::start(FakeOptions::default()).await;
        let url = fake.url();
        let text = exchange(
            fake.port,
            &format!("DESCRIBE {url} RTSP/1.0\r\nCSeq: 1\r\n\r\n"),
        )
        .await;
        assert!(text.starts_with("RTSP/1.0 401"), "{text}");
        assert!(text.contains("CSeq: 1"));
        assert!(text.contains("WWW-Authenticate: Basic"));

        let text = exchange(
            fake.port,
            &format!(
                "DESCRIBE {url} RTSP/1.0\r\nCSeq: 2\r\nAuthorization: {}\r\n\r\n",
                basic_auth_header()
            ),
        )
        .await;
        assert!(text.starts_with("RTSP/1.0 200"), "{text}");
        assert!(text.contains("a=rtpmap:96 H264/90000"));
        assert!(text.contains("sprop-parameter-sets="));
        assert_eq!(fake.accepts(), 2);
    }
}
