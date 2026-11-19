package srv

func (s *Server) Start() error {
	return nil
}

type Server struct {
	addr string
}

var defaultServer = newServer()

func newServer() *Server { return &Server{} }
