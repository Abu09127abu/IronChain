const express = require('express');
const cors = require('cors');
const path = require('path');
const { Pool } = require('pg');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 8545;
const CHAIN_ID = 18174582;
const CHAIN_ID_HEX = "0x1155276";
const GENESIS_HOLDER = "0xb042ee3c9019a23387f48436275af15063b7820f";
const TOTAL_SUPPLY_HEX = "0x33b2e3c9fd0803ce8000000"; // 1 Billion IRON

const pool = process.env.DATABASE_URL
  ? new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })
  : null;

let memState = {
  blockHeight: 120,
  accounts: { [GENESIS_HOLDER]: { balance: TOTAL_SUPPLY_HEX, nonce: 0 } },
  tokens: [
    {
      address: "0x382910c2839102c8129381029381029381029381",
      name: "Iron Dollar",
      symbol: "iUSD",
      decimals: 18,
      totalSupply: "10,000,000",
      iconUrl: "https://cryptologos.cc/logos/tether-usdt-logo.png",
      creator: GENESIS_HOLDER
    }
  ],
  transactions: []
};

async function initDb() {
  if (!pool) return;
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS chain_meta (key VARCHAR(50) PRIMARY KEY, value TEXT);
      CREATE TABLE IF NOT EXISTS accounts (address VARCHAR(66) PRIMARY KEY, balance_hex TEXT NOT NULL, nonce INT DEFAULT 0);
      CREATE TABLE IF NOT EXISTS transactions (hash VARCHAR(66) PRIMARY KEY, block_number BIGINT, from_addr VARCHAR(66), to_addr VARCHAR(66), value_hex TEXT, data TEXT, created_at TIMESTAMPTZ DEFAULT NOW());
      CREATE TABLE IF NOT EXISTS tokens (address VARCHAR(66) PRIMARY KEY, name VARCHAR(100), symbol VARCHAR(20), decimals INT DEFAULT 18, total_supply TEXT, icon_url TEXT, creator VARCHAR(66), created_at TIMESTAMPTZ DEFAULT NOW());
      INSERT INTO chain_meta (key, value) VALUES ('block_height', '120') ON CONFLICT DO NOTHING;
      INSERT INTO accounts (address, balance_hex, nonce) VALUES ('${GENESIS_HOLDER}', '${TOTAL_SUPPLY_HEX}', 0) ON CONFLICT DO NOTHING;
    `);
    console.log("[DB] PostgreSQL Connected and Tables Initialized!");
  } catch (err) {
    console.error("[DB Init Error]", err.message);
  }
}
initDb();

async function getBlockNumber() {
  if (pool) {
    try {
      const res = await pool.query("SELECT value FROM chain_meta WHERE key = 'block_height'");
      return parseInt(res.rows[0]?.value || "120", 10);
    } catch (e) {}
  }
  return memState.blockHeight;
}

async function incrementBlockNumber() {
  if (pool) {
    try {
      const res = await pool.query("UPDATE chain_meta SET value = (value::bigint + 1)::text WHERE key = 'block_height' RETURNING value");
      return parseInt(res.rows[0].value, 10);
    } catch (e) {}
  }
  return ++memState.blockHeight;
}

async function getBalance(addr) {
  addr = (addr || "").toLowerCase();
  if (addr === GENESIS_HOLDER) return TOTAL_SUPPLY_HEX;
  if (pool) {
    try {
      const res = await pool.query("SELECT balance_hex FROM accounts WHERE address = $1", [addr]);
      return res.rows[0]?.balance_hex || "0x0";
    } catch (e) {}
  }
  return memState.accounts[addr]?.balance || "0x0";
}

async function handleSingleRpc(req) {
  const id = req.id !== undefined ? req.id : 1;
  const method = req.method;
  const params = req.params || [];

  if (method === "eth_chainId") return { jsonrpc: "2.0", id, result: CHAIN_ID_HEX };
  if (method === "net_version") return { jsonrpc: "2.0", id, result: String(CHAIN_ID) };
  if (method === "web3_clientVersion") return { jsonrpc: "2.0", id, result: "IRON-Mainnet-Core/v1.0" };
  if (method === "net_listening") return { jsonrpc: "2.0", id, result: true };
  if (method === "net_peerCount") return { jsonrpc: "2.0", id, result: "0x19" };

  if (method === "eth_blockNumber") {
    const bn = await getBlockNumber();
    return { jsonrpc: "2.0", id, result: "0x" + bn.toString(16) };
  }

  if (method === "eth_getBalance") {
    const bal = await getBalance(params[0]);
    return { jsonrpc: "2.0", id, result: bal };
  }

  if (method === "eth_getTransactionCount") return { jsonrpc: "2.0", id, result: "0x0" };
  if (method === "eth_gasPrice" || method === "eth_maxPriorityFeePerGas") return { jsonrpc: "2.0", id, result: "0x3b9aca00" };
  if (method === "eth_estimateGas") return { jsonrpc: "2.0", id, result: "0x5208" };
  if (method === "eth_call" || method === "eth_getCode") return { jsonrpc: "2.0", id, result: "0x" };
  if (method === "eth_syncing") return { jsonrpc: "2.0", id, result: false };

  if (method === "eth_getBlockByNumber" || method === "eth_getBlockByHash") {
    const bn = await getBlockNumber();
    return {
      jsonrpc: "2.0", id,
      result: {
        number: "0x" + bn.toString(16),
        hash: "0x" + "a".repeat(64),
        parentHash: "0x" + "b".repeat(64),
        nonce: "0x0000000000000042",
        sha3Uncles: "0x1dcc4de8dec75d7aab85b567b6ccd41ad312451b948a7413f0a142fd40d49347",
        logsBloom: "0x" + "0".repeat(512),
        transactionsRoot: "0x56e81f171bcc55a6ff8345e692c0f86e5b48e01b996cadc001622fb5e363b421",
        stateRoot: "0xd7f8924f16b16feab07e5e1e127393de5843a85b46b28a9be19001b22e118923",
        miner: GENESIS_HOLDER,
        gasLimit: "0x1c9c380",
        gasUsed: "0x0",
        timestamp: "0x" + Math.floor(Date.now() / 1000).toString(16),
        transactions: [],
        baseFeePerGas: "0x3b9aca00"
      }
    };
  }

  if (method === "eth_sendRawTransaction") {
    const newBlock = await incrementBlockNumber();
    const txHash = "0x" + [...Array(64)].map(() => Math.floor(Math.random() * 16).toString(16)).join("");
    if (pool) {
      try {
        await pool.query(
          "INSERT INTO transactions (hash, block_number, from_addr, to_addr, value_hex, data) VALUES ($1, $2, $3, $4, $5, $6)",
          [txHash, newBlock, GENESIS_HOLDER, "0x0000000000000000000000000000000000000000", "0x0", params[0] || ""]
        );
      } catch (e) {}
    }
    return { jsonrpc: "2.0", id, result: txHash };
  }

  return { jsonrpc: "2.0", id, result: "0x0" };
}

app.post(['/', '/rpc'], async (req, res) => {
  if (Array.isArray(req.body)) {
    const results = await Promise.all(req.body.map(handleSingleRpc));
    return res.json(results);
  }
  const result = await handleSingleRpc(req.body);
  res.json(result);
});

app.get('/api/stats', async (req, res) => {
  const bn = await getBlockNumber();
  let tokenCount = 1;
  let txCount = 0;
  if (pool) {
    try {
      const tc = await pool.query("SELECT COUNT(*) FROM tokens");
      tokenCount = parseInt(tc.rows[0].count, 10);
      const txc = await pool.query("SELECT COUNT(*) FROM transactions");
      txCount = parseInt(txc.rows[0].count, 10);
    } catch (e) {}
  }
  res.json({
    chainName: "IRON Mainnet",
    chainId: CHAIN_ID,
    chainIdHex: CHAIN_ID_HEX,
    symbol: "IRON",
    blockHeight: bn,
    totalSupply: "1,000,000,000 IRON",
    genesisHolder: GENESIS_HOLDER,
    tokenCount,
    txCount
  });
});

app.get('/api/tokens', async (req, res) => {
  if (pool) {
    try {
      const r = await pool.query("SELECT * FROM tokens ORDER BY created_at DESC");
      return res.json(r.rows);
    } catch (e) {}
  }
  res.json(memState.tokens);
});

app.post('/api/tokens/create', async (req, res) => {
  const { name, symbol, decimals, totalSupply, iconUrl, creator } = req.body;
  if (!name || !symbol) return res.status(400).json({ error: "Name and Symbol required" });

  const tokenAddress = "0x" + [...Array(40)].map(() => Math.floor(Math.random() * 16).toString(16)).join("");
  const newToken = {
    address: tokenAddress,
    name,
    symbol: symbol.toUpperCase(),
    decimals: decimals || 18,
    total_supply: totalSupply || "1,000,000",
    icon_url: iconUrl || "https://cryptologos.cc/logos/ethereum-eth-logo.png",
    creator: creator || GENESIS_HOLDER
  };

  if (pool) {
    try {
      await pool.query(
        "INSERT INTO tokens (address, name, symbol, decimals, total_supply, icon_url, creator) VALUES ($1, $2, $3, $4, $5, $6, $7)",
        [newToken.address, newToken.name, newToken.symbol, newToken.decimals, newToken.total_supply, newToken.icon_url, newToken.creator]
      );
    } catch (e) {}
  }

  await incrementBlockNumber();
  res.json({ success: true, token: newToken });
});

app.listen(PORT, () => {
  console.log(`IRON MAINNET RUNNING on port ${PORT}`);
});
