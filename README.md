# 🚇 Tunnel Chat

**Ephemeral peer-to-peer tunnel chat from the terminal**

Create secure, temporary chat rooms that connect peers directly through WebRTC tunnels. Perfect for quick collaboration, file sharing, or secure communication without leaving your terminal.

## ✨ Features

- 🔒 **End-to-end encrypted** peer-to-peer communication
- 🚀 **Zero configuration** - works out of the box
- 📱 **Cross-platform** - works on macOS, Linux, and Windows
- 🌐 **NAT traversal** - connects through firewalls and routers
- 💬 **Real-time chat** with typing indicators
- 📁 **File sharing** capabilities
- 🎯 **Ephemeral rooms** - automatically cleaned up
- 🔑 **Pro features** with TURN servers for reliable connections

## 🚀 Quick Start

### Basic Usage (Free)

```bash
# Start a chat room
npx tunnel-chat@latest

# Join an existing room
npx tunnel-chat@latest join <room-name>
```

### Pro Usage (Paid)

Get your API key and unlock premium features:

```bash
# Get your Pro API key
npx tunnel-chat@latest auth your-email@example.com

# Set your API key
export TUNNEL_API_KEY="sk_..."

# Now enjoy Pro features with reliable TURN servers
npx tunnel-chat@latest
```

## 📦 Installation

### Global Installation
```bash
npm install -g tunnel-chat
# or
pnpm add -g tunnel-chat
```

### One-time Usage
```bash
npx tunnel-chat@latest
```

## 🎮 Commands

| Command | Description |
|---------|-------------|
| `tunnel-chat` | Create or join a chat room |
| `tunnel-chat join <name>` | Join a specific room |
| `tunnel-chat auth <email>` | Get your Pro API key |
| `tunnel-chat upgrade` | Upgrade to Pro plan |

### In-Chat Commands

| Command | Description |
|---------|-------------|
| `/help` | Show available commands |
| `/quit` or `/exit` | Leave the chat |
| `/upload <file>` | Share a file (Pro only) |
| `/fpkey` | Show DTLS fingerprints for verification |

## 🔧 Configuration

### Environment Variables

| Variable | Description | Required |
|----------|-------------|----------|
| `TUNNEL_API_KEY` | Your Pro API key for premium features | No |
| `TUNNEL_SIGNAL` | Custom signaling server URL | No |
| `BILLING_SERVER` | Custom billing server URL | No |

### Example Configuration

```bash
# Set your Pro API key
export TUNNEL_API_KEY="sk_ditch_abc123..."

# Optional: Use custom signaling server
export TUNNEL_SIGNAL="wss://your-server.com"
```

## 💎 Pro Features

Upgrade to Pro for enhanced reliability and features:

- 🌐 **TURN servers** for guaranteed connectivity through corporate firewalls
- 📁 **File uploads** to cloud storage
- 🔄 **Multi-peer rooms** (coming soon)
- 🛡️ **Priority support**

[**Upgrade to Pro →**](https://ditch.chat)

## 🏗️ Self-Hosting

Want to run your own instance? Here's how:

### Server Requirements

- Node.js 20+
- Stripe account (for billing)
- Resend account (for emails)
- Optional: TURN server for NAT traversal

### Environment Variables

```bash
# Required for billing
STRIPE_SECRET_KEY=sk_live_...
STRIPE_PRICE_ID=price_...
STRIPE_WEBHOOK_SECRET=whsec_...

# Required for email auth
RESEND_API_KEY=re_...
RESEND_FROM=no-reply@yourdomain.com
PUBLIC_BASE_URL=https://yourdomain.com

# Optional TURN server
TURN_SECRET=your-coturn-secret
TURN_REALM=yourdomain.com

# Server config
PORT=8787
KEYS_PATH=./server/keys.json
```

### Deploy with Docker

```bash
# Build the image
docker build -t tunnel-chat .

# Run with environment variables
docker run -p 8787:8787 \
  -e STRIPE_SECRET_KEY=sk_live_... \
  -e RESEND_API_KEY=re_... \
  tunnel-chat
```

### Deploy to Fly.io

```bash
# Install Fly CLI
curl -L https://fly.io/install.sh | sh

# Deploy
fly deploy
```

## 🔒 Security

- **End-to-end encryption**: All messages are encrypted using WebRTC's built-in DTLS
- **Ephemeral**: Rooms are automatically deleted after inactivity
- **No data retention**: Messages are never stored on servers
- **Peer verification**: Use `/fpkey` to verify connection fingerprints
- **Open source**: Full transparency - audit the code yourself

## 🛠️ Development

### Setup

```bash
# Clone the repository
git clone https://github.com/razchiriac/tunnel-chat.git
cd tunnel-chat

# Install dependencies
pnpm install

# Build the project
pnpm run build
```

### Scripts

```bash
pnpm run dev          # Development CLI
pnpm run server       # Run signaling server only
pnpm run combined     # Run combined billing + signaling server
pnpm run build        # Build TypeScript to JavaScript
```

### Architecture

```
┌─────────────┐    ┌─────────────┐    ┌─────────────┐
│   Client A  │    │  Signaling  │    │   Client B  │
│             │◄──►│   Server    │◄──►│             │
│             │    │             │    │             │
└─────────────┘    └─────────────┘    └─────────────┘
       │                                      │
       │            Direct P2P Connection     │
       └──────────────────────────────────────┘
```

- **Signaling Server**: Facilitates WebRTC handshake
- **TURN Servers**: Help with NAT traversal (Pro only)
- **Billing Server**: Handles Stripe subscriptions and API keys
- **P2P Connection**: Direct encrypted communication between peers

## 🤝 Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

### Guidelines

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## 📄 License

MIT License - see [LICENSE](LICENSE) file for details.

## 🆘 Support


- 🐛 Issues: [GitHub Issues](https://github.com/razchiriac/tunnel-chat/issues)

## 🙏 Acknowledgments

- Built with [WebRTC](https://webrtc.org/) for peer-to-peer communication
- [Stripe](https://stripe.com/) for payment processing
- [Resend](https://resend.com/) for transactional emails
- [Cloudflare](https://cloudflare.com/) for CDN and DNS services 
- [Fly.io](https://fly.io/) for hosting

---

**Made with ❤️ by the Tunnel Chat team**

[Website](https://ditch.chat) • [GitHub](https://github.com/razchiriac/tunnel-chat)
