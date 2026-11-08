//! Fork-only modules (not part of upstream gyng/widgetsack). Core files touch this tree only via
//! `mod fork;` in `main.rs`, so upstream merges stay conflict-free.

pub mod camera;
pub mod hwinfo;
pub mod notifyfeed;
pub mod server_check;
pub mod stocks_cbr;
pub mod weather_metno;
