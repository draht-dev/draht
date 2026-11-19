mod store;
pub mod util;

use crate::store::{Store, Json};
use util::helper;

pub fn run() {
    let s = Store::new();
    s.save();
    helper(1);
    let Json(inner) = Json(2);
    fn local() {}
}
