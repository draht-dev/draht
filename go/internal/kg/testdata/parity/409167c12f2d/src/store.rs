pub struct Store;
pub struct Json(pub u8);
pub trait Save { fn save(&self); fn twice(&self) { self.save(); } }

impl Store {
    pub fn new() -> Self { Self::build() }
    fn build() -> Self { Store }
}

impl Save for Store {
    fn save(&self) { self.flush(); }
}

impl Store { fn flush(&self) {} }

pub type Alias = Store;
pub const LIMIT: u8 = 3;
