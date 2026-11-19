package store

func (s *Store) Save(k Key) error {
	return s.flush()
}

func (s *Store) flush() error { return nil }

func (*Store) Close() {}
