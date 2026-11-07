//! Fork-only modules (not part of upstream gyng/widgetsack). Core files touch this tree only via
//! `mod fork;` in `main.rs`, so upstream merges stay conflict-free.

pub mod server_check;
pub mod weather_metno;
