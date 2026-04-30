import { MongoClient } from 'mongodb';
import dns from 'dns';

let cachedClient = null;
let cachedDb = null;
let dnsFallbackApplied = false;

export async function getDb() {
  if (cachedDb) return cachedDb;

  const uri = process.env.MONGODB_URI;
  const dbName = process.env.MONGODB_DB || 'payment_gateway';

  if (!uri) {
    throw new Error('Missing MONGODB_URI environment variable');
  }

  if (isPlaceholderMongoUri(uri)) {
    throw new Error('MONGODB_URI is still a placeholder. Put your real MongoDB connection string in .env.local.');
  }

  if (!cachedClient) {
    cachedClient = await connectMongo(uri);
  }

  cachedDb = cachedClient.db(dbName);
  await ensureIndexes(cachedDb);
  return cachedDb;
}

async function connectMongo(uri) {
  try {
    return await createConnectedClient(uri);
  } catch (error) {
    if (!dnsFallbackApplied && shouldRetryWithDnsFallback(uri, error)) {
      dnsFallbackApplied = true;
      dns.setServers(getMongoDnsServers());
      return createConnectedClient(uri);
    }
    throw error;
  }
}

async function createConnectedClient(uri) {
  const client = new MongoClient(uri, {
    maxPoolSize: 10,
    serverSelectionTimeoutMS: 10_000,
    appName: process.env.MONGODB_APP_NAME || 'gatewayflow-api'
  });
  await client.connect();
  return client;
}

function shouldRetryWithDnsFallback(uri, error) {
  return String(uri || '').startsWith('mongodb+srv://') && String(error?.code || '').toUpperCase() === 'ECONNREFUSED';
}

function getMongoDnsServers() {
  const configured = String(process.env.MONGODB_DNS_SERVERS || '').split(',').map((item) => item.trim()).filter(Boolean);
  return configured.length ? configured : ['8.8.8.8', '1.1.1.1'];
}

let indexesEnsured = false;
async function ensureIndexes(db) {
  if (indexesEnsured) return;
  await db.collection('payments').createIndex({ transaction_id: 1 }, { unique: true });
  await db.collection('payments').createIndex({ createdAt: -1 });
  await db.collection('payments').createIndex({ sender: 1 });
  await db.collection('payments').createIndex({ usedFor: 1 });
  await db.collection('payments').createIndex({ submittedByClientId: 1, createdAt: -1 });
  await db.collection('payments').createIndex({ clientId: 1, createdAt: -1 });
  await db.collection('clients').createIndex({ email: 1 }, { unique: true });
  await db.collection('clients').createIndex({ createdAt: -1 });
  await db.collection('clients').createIndex({ role: 1, createdAt: -1 });
  await db.collection('websites').createIndex({ clientId: 1, createdAt: -1 });
  await db.collection('websites').createIndex({ domain: 1 }, { unique: true });
  await db.collection('websites').createIndex({ apiKey: 1 }, { unique: true });
  await db.collection('websites').createIndex({ brandStatus: 1, createdAt: -1 });
  await db.collection('websites').createIndex({ paymentStatus: 1, createdAt: -1 });
  await db.collection('websites').createIndex({ walletNumber: 1 });
  await db.collection('subscription_renewals').createIndex({ transaction_id: 1 }, { unique: true });
  await db.collection('subscription_renewals').createIndex({ websiteId: 1, paidAt: -1 });
  await db.collection('payment_verifications').createIndex({ transaction_id: 1 }, { unique: true });
  await db.collection('payment_verifications').createIndex({ websiteId: 1, createdAt: -1 });
  await db.collection('payment_verifications').createIndex({ clientId: 1, createdAt: -1 });
  await db.collection('client_devices').createIndex({ clientId: 1, lastSeenAt: -1 });
  await db.collection('client_devices').createIndex({ clientId: 1, deviceId: 1 }, { unique: true });
  await db.collection('client_settings').createIndex({ clientId: 1 }, { unique: true });
  await db.collection('support_tickets').createIndex({ clientId: 1, createdAt: -1 });
  await db.collection('billing_requests').createIndex({ clientId: 1, createdAt: -1 });
  await db.collection('billing_requests').createIndex({ websiteId: 1, createdAt: -1 });
  await db.collection('billing_requests').createIndex({ status: 1, createdAt: -1 });
  await db.collection('billing_requests').createIndex({ transaction_id: 1 }, { unique: true, sparse: true });
  indexesEnsured = true;
}

function isPlaceholderMongoUri(uri) {
  const value = String(uri || '').trim();
  return !value.startsWith('mongodb://') && !value.startsWith('mongodb+srv://')
    || /USER:PASSWORD|cluster\.example/i.test(value);
}
