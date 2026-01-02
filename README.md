# AI Trading Assistant

A strategy-first AI trading assistant for fast scalping on Bybit, with strict risk management and anti-rage enforcement.

## Features

- **Strategy Truth Engine**: Single source of truth for trade decisions
- **Two-layer Validation**: Hard gate (blocking) + Soft coach (advisory)
- **Auto-exit**: Automatic position closure on invalidation
- **Anti-rage Protection**: Prevents emotional re-entry after losses
- **Leverage Cap**: Never exceeds 10x leverage
- **Full Journaling**: Complete audit trail of all decisions

## Quick Start

### Prerequisites

- Node.js 18+
- PostgreSQL database
- Redis (for job queue)
- Bybit API keys (testnet recommended for development)

### Installation

```bash
# Install dependencies
npm install

# Copy environment file
cp .env.example .env

# Configure your .env file with:
# - DATABASE_URL
# - REDIS_URL
# - BYBIT_API_KEY
# - BYBIT_API_SECRET
# - BYBIT_TESTNET=true (recommended for testing)

# Generate Prisma client
npm run db:generate

# Push database schema
npm run db:push

# Start development server
npm run dev
```

### API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/health` | GET | Health check |
| `/api/status` | GET | Detailed status |
| `/api/market/ticker/:symbol` | GET | Get ticker |
| `/api/market/candles/:symbol/:timeframe` | GET | Get candles |
| `/api/market/balance` | GET | Get wallet balance |
| `/api/market/positions` | GET | Get all positions |
| `/api/settings` | GET/PATCH | Manage settings |

## Project Structure

```
src/
├── api/                 # Express API server
│   ├── routes/          # Route handlers
│   └── app.ts           # Express app setup
├── bybit/               # Bybit integration
│   ├── rest-client.ts   # REST API client
│   ├── market-ws.ts     # Market WebSocket
│   └── private-ws.ts    # Private WebSocket
├── config/              # Configuration
├── data/                # Data management
│   └── candle-manager.ts
├── db/                  # Database (Prisma)
├── types/               # TypeScript types
├── utils/               # Utilities
└── index.ts             # Entry point
```

## Development Phases

- [x] **Phase 1A**: Project setup, database schema, core types
- [x] **Phase 1B**: Bybit integration (REST + WebSocket + Candle manager)
- [ ] **Phase 2**: Strategy Engine (indicators, StrategyState)
- [ ] **Phase 3**: Execution Engine (order management)
- [ ] **Phase 4**: Agent Orchestrator (intent parsing, state machine)
- [ ] **Phase 5**: Auto-exit & Invalidation
- [ ] **Phase 6**: Frontend (React)
- [ ] **Phase 7**: Watch/Scanner system
- [ ] **Phase 8**: Journaling & Analytics

## Safety Notes

⚠️ **IMPORTANT**: Always use testnet first!

- Set `BYBIT_TESTNET=true` in your `.env`
- Never commit API keys
- Maximum leverage is hardcoded to 10x
- The system will refuse trades that don't match strategy rules

## License

MIT

