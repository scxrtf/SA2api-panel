package main

import (
	"bufio"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"

	utls "github.com/refraction-networking/utls"
)

const handshakeTimeout = 10 * time.Second

type request struct {
	ServerName string `json:"serverName"`
	Host       string `json:"host"`
	Port       int    `json:"port"`
	Proxy      string `json:"proxy,omitempty"`
	RootCAPEM  string `json:"rootCA,omitempty"`
}

var officialCipherSuites = []uint16{
	tls.TLS_AES_128_GCM_SHA256, tls.TLS_AES_256_GCM_SHA384,
	tls.TLS_CHACHA20_POLY1305_SHA256, tls.TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256,
	tls.TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256, tls.TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384,
	tls.TLS_ECDHE_ECDSA_WITH_AES_256_GCM_SHA384, tls.TLS_ECDHE_RSA_WITH_AES_128_CBC_SHA256,
	tls.TLS_ECDHE_ECDSA_WITH_CHACHA20_POLY1305_SHA256, tls.TLS_ECDHE_RSA_WITH_CHACHA20_POLY1305_SHA256,
	tls.TLS_ECDHE_ECDSA_WITH_AES_128_CBC_SHA, tls.TLS_ECDHE_RSA_WITH_AES_128_CBC_SHA,
	tls.TLS_ECDHE_ECDSA_WITH_AES_256_CBC_SHA, tls.TLS_ECDHE_RSA_WITH_AES_256_CBC_SHA,
	tls.TLS_RSA_WITH_AES_128_GCM_SHA256, tls.TLS_RSA_WITH_AES_256_GCM_SHA384,
	tls.TLS_RSA_WITH_AES_128_CBC_SHA, tls.TLS_RSA_WITH_AES_256_CBC_SHA,
}

var officialSigAlgs = []utls.SignatureScheme{
	0x0403, 0x0804, 0x0401, 0x0503, 0x0805, 0x0501, 0x0806, 0x0601, 0x0201,
}

func officialHelloSpec() *utls.ClientHelloSpec {
	return &utls.ClientHelloSpec{
		TLSVersMin: tls.VersionTLS12, TLSVersMax: tls.VersionTLS13,
		CipherSuites: officialCipherSuites, CompressionMethods: []byte{0},
		Extensions: []utls.TLSExtension{
			&utls.SNIExtension{},
			&utls.UtlsExtendedMasterSecretExtension{},
			&utls.RenegotiationInfoExtension{Renegotiation: utls.RenegotiateOnceAsClient},
			&utls.SupportedCurvesExtension{Curves: []utls.CurveID{utls.X25519, utls.CurveP256, utls.CurveP384}},
			&utls.SupportedPointsExtension{SupportedPoints: []byte{0}},
			&utls.SessionTicketExtension{},
			&utls.SignatureAlgorithmsExtension{SupportedSignatureAlgorithms: officialSigAlgs},
			&utls.KeyShareExtension{KeyShares: []utls.KeyShare{{Group: utls.X25519}}},
			&utls.PSKKeyExchangeModesExtension{Modes: []uint8{utls.PskModeDHE}},
			&utls.SupportedVersionsExtension{Versions: []uint16{tls.VersionTLS13, tls.VersionTLS12}},
		},
	}
}

func connectTunnel(raw net.Conn, req request, proxy *url.URL) error {
	authority := net.JoinHostPort(req.Host, fmt.Sprint(req.Port))
	var head strings.Builder
	fmt.Fprintf(&head, "CONNECT %s HTTP/1.1\r\nHost: %s\r\nProxy-Connection: keep-alive\r\n", authority, authority)
	if proxy.User != nil {
		password, _ := proxy.User.Password()
		credentials := base64.StdEncoding.EncodeToString([]byte(proxy.User.Username() + ":" + password))
		fmt.Fprintf(&head, "Proxy-Authorization: Basic %s\r\n", credentials)
	}
	head.WriteString("\r\n")
	if _, err := io.WriteString(raw, head.String()); err != nil {
		return err
	}
	connectReq := &http.Request{Method: http.MethodConnect}
	response, err := http.ReadResponse(bufio.NewReader(raw), connectReq)
	if err != nil {
		return err
	}
	response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return fmt.Errorf("proxy CONNECT status %d", response.StatusCode)
	}
	return nil
}

func run(req request, input io.Reader) error {
	host, port := req.Host, req.Port
	var proxy *url.URL
	var err error
	if req.Proxy != "" {
		proxy, err = url.Parse(req.Proxy)
		if err != nil {
			return err
		}
		if proxy.Scheme != "http" {
			return errors.New("only HTTP CONNECT proxies are supported")
		}
		host = proxy.Hostname()
		port = 80
		if proxy.Port() != "" {
			fmt.Sscan(proxy.Port(), &port)
		}
	}
	raw, err := net.DialTimeout("tcp", net.JoinHostPort(host, fmt.Sprint(port)), handshakeTimeout)
	if err != nil {
		return err
	}
	defer raw.Close()
	raw.SetDeadline(time.Now().Add(handshakeTimeout))
	if proxy != nil {
		if err := connectTunnel(raw, req, proxy); err != nil {
			return err
		}
	}
	config := &utls.Config{ServerName: req.ServerName, MinVersion: tls.VersionTLS12}
	if req.RootCAPEM != "" {
		roots := x509.NewCertPool()
		if !roots.AppendCertsFromPEM([]byte(req.RootCAPEM)) {
			return errors.New("invalid root CA")
		}
		config.RootCAs = roots
	}
	client := utls.UClient(raw, config, utls.HelloCustom)
	if err := client.ApplyPreset(officialHelloSpec()); err != nil {
		return err
	}
	if err := client.Handshake(); err != nil {
		return err
	}
	raw.SetDeadline(time.Time{})
	_ = raw.SetReadDeadline(time.Time{})
	_ = raw.SetWriteDeadline(time.Time{})
	if _, err := io.WriteString(os.Stdout, "READY\n"); err != nil {
		return err
	}
	done := make(chan error, 2)
	go func() {
		_, err := io.Copy(client, input)
		client.CloseWrite()
		done <- err
	}()
	go func() {
		_, err := io.Copy(os.Stdout, client)
		done <- err
	}()
	err = <-done
	if tcp, ok := raw.(*net.TCPConn); ok {
		_ = tcp.CloseRead()
	}
	_ = client.Close()
	return err
}

func main() {
	input := bufio.NewReader(os.Stdin)
	line, err := input.ReadBytes('\n')
	if err != nil {
		fmt.Fprintln(os.Stderr, strings.TrimSpace(err.Error()))
		os.Exit(2)
	}
	decoder := json.NewDecoder(strings.NewReader(string(line)))
	decoder.DisallowUnknownFields()
	var req request
	if err := decoder.Decode(&req); err != nil {
		fmt.Fprintln(os.Stderr, strings.TrimSpace(err.Error()))
		os.Exit(2)
	}
	if req.ServerName == "" || req.Host == "" || req.Port < 1 || req.Port > 65535 {
		fmt.Fprintln(os.Stderr, "invalid TLS connection request")
		os.Exit(2)
	}
	if err := run(req, input); err != nil && !errors.Is(err, io.EOF) {
		fmt.Fprintln(os.Stderr, strings.TrimSpace(err.Error()))
		os.Exit(1)
	}
}
