import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { MongoClient } from 'mongodb';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

async function loadEnvFile(fileName) {
  const filePath = path.join(rootDir, fileName);
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const i = trimmed.indexOf('=');
      if (i <= 0) continue;
      const key = trimmed.slice(0, i).trim();
      if (!key || process.env[key]) continue;
      const value = trimmed.slice(i + 1).trim().replace(/^['"]|['"]$/g, '');
      process.env[key] = value;
    }
  } catch (error) {
    // ignore missing env file
  }
}

function canonicalPayer(value = '') {
  const digits = String(value || '').replace(/\D/g, '');
  if (!digits) return '';
  if (digits.startsWith('8801') && digits.length >= 13) return `0${digits.slice(-10)}`;
  if (digits.startsWith('01') && digits.length >= 11) return digits.slice(0, 11);
  return digits;
}

function amountKey(value) {
  return Number(value || 0).toFixed(2);
}

function argValue(name, fallback = '') {
  const args = process.argv.slice(2);
  const exact = args.find((item) => item.startsWith(`${name}=`));
  if (exact) return exact.split('=').slice(1).join('=');
  const index = args.indexOf(name);
  if (index >= 0 && args[index + 1]) return args[index + 1];
  return fallback;
}

async function run() {
  await loadEnvFile('.env');
  await loadEnvFile('.env.local');

  const uri = process.env.MONGODB_URI;
  const dbName = process.env.MONGODB_DB || 'payment_gateway';
  const domain = argValue('--domain', '').trim().toLowerCase();
  const list = process.argv.includes('--list');
  const all = process.argv.includes('--all');
  const contains = argValue('--contains', '').trim().toLowerCase();
  const apply = process.argv.includes('--apply');
  if (!uri) {
    throw new Error('Missing MONGODB_URI. Put it in .env.local');
  }
  if (!domain && !contains && !list && !all) {
    throw new Error('Provide --domain <value>, --contains <text>, --list, or --all');
  }

  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 15000 });
  await client.connect();

  try {
    const db = client.db(dbName);
    if (list) {
      const websites = await db.collection('websites')
        .find({}, { projection: { domain: 1, name: 1, createdAt: 1 } })
        .sort({ createdAt: -1 })
        .limit(300)
        .toArray();

      const domains = websites
        .map((item) => ({
          domain: String(item.domain || '').toLowerCase(),
          name: String(item.name || '')
        }))
        .filter((item) => item.domain);

      console.log(JSON.stringify({
        count: domains.length,
        domains
      }, null, 2));
      return;
    }

    if (contains) {
      const websites = await db.collection('websites')
        .find({}, { projection: { domain: 1, name: 1 } })
        .sort({ createdAt: -1 })
        .limit(500)
        .toArray();
      const hits = websites
        .map((item) => ({
          domain: String(item.domain || '').toLowerCase(),
          name: String(item.name || '')
        }))
        .filter((item) => item.domain.includes(contains));

      console.log(JSON.stringify({
        contains,
        count: hits.length,
        domains: hits
      }, null, 2));
      return;
    }

    if (all) {
      const pendingFilter = {
        status: { $in: ['pending', 'pending_sms', 'pending_review'] }
      };
      const rows = await db.collection('merchant_verification_requests')
        .find(pendingFilter, {
          projection: {
            _id: 1,
            websiteId: 1,
            transaction_id: 1,
            order_id: 1,
            payer_number: 1,
            amount: 1,
            createdAt: 1
          }
        })
        .sort({ createdAt: -1, _id: -1 })
        .toArray();

      const websites = await db.collection('websites')
        .find({}, { projection: { _id: 1, domain: 1, name: 1 } })
        .toArray();
      const websiteMap = new Map(websites.map((item) => [String(item._id), item]));

      const grouped = new Map();
      for (const row of rows) {
        const websiteId = String(row.websiteId || 'unknown');
        const tx = String(row.transaction_id || '').trim().toUpperCase();
        const key = tx && !tx.startsWith('AUTO-')
          ? `tx:${tx}`
          : `order:${String(row.order_id || '').trim().toLowerCase()}|payer:${canonicalPayer(row.payer_number)}|amount:${amountKey(row.amount)}`;
        const fullKey = `${websiteId}||${key}`;
        if (!grouped.has(fullKey)) grouped.set(fullKey, []);
        grouped.get(fullKey).push(row);
      }

      const duplicateIds = [];
      const perWebsite = new Map();
      for (const [fullKey, items] of grouped.entries()) {
        if (items.length <= 1) continue;
        const websiteId = fullKey.split('||')[0];
        if (!perWebsite.has(websiteId)) {
          perWebsite.set(websiteId, { groups: 0, duplicateCandidates: 0 });
        }
        const stat = perWebsite.get(websiteId);
        stat.groups += 1;
        stat.duplicateCandidates += (items.length - 1);

        for (let i = 1; i < items.length; i += 1) {
          duplicateIds.push(items[i]._id);
        }
      }

      let modified = 0;
      if (apply && duplicateIds.length) {
        const result = await db.collection('merchant_verification_requests').updateMany(
          {
            _id: { $in: duplicateIds },
            status: { $in: ['pending', 'pending_sms', 'pending_review'] }
          },
          {
            $set: {
              status: 'rejected_duplicate',
              adminNote: 'One-time cleanup: duplicate pending merged under latest pending request',
              updatedAt: new Date()
            }
          }
        );
        modified = result.modifiedCount || 0;
      }

      const pendingAfter = await db.collection('merchant_verification_requests').countDocuments(pendingFilter);
      const websiteStats = Array.from(perWebsite.entries())
        .map(([websiteId, stat]) => {
          const website = websiteMap.get(websiteId);
          return {
            websiteId,
            domain: String(website?.domain || ''),
            name: String(website?.name || ''),
            groups: stat.groups,
            duplicateCandidates: stat.duplicateCandidates
          };
        })
        .sort((a, b) => b.duplicateCandidates - a.duplicateCandidates)
        .slice(0, 50);

      console.log(JSON.stringify({
        mode: 'all',
        apply,
        pendingRowsScanned: rows.length,
        duplicateCandidates: duplicateIds.length,
        modified,
        pendingAfter,
        affectedWebsites: websiteStats.length,
        websites: websiteStats
      }, null, 2));
      return;
    }

    const website = await db.collection('websites').findOne(
      { domain },
      { projection: { _id: 1, domain: 1 } }
    );

    if (!website) {
      console.log(JSON.stringify({ domain, found: false }, null, 2));
      return;
    }

    const pendingFilter = {
      websiteId: website._id,
      status: { $in: ['pending', 'pending_sms', 'pending_review'] }
    };

    const beforePending = await db.collection('merchant_verification_requests').countDocuments(pendingFilter);

    const rows = await db.collection('merchant_verification_requests')
      .find(pendingFilter, {
        projection: {
          _id: 1,
          transaction_id: 1,
          order_id: 1,
          payer_number: 1,
          amount: 1,
          createdAt: 1,
          status: 1
        }
      })
      .sort({ createdAt: -1, _id: -1 })
      .toArray();

    const groups = new Map();
    for (const row of rows) {
      const tx = String(row.transaction_id || '').trim().toUpperCase();
      const key = tx && !tx.startsWith('AUTO-')
        ? `tx:${tx}`
        : `order:${String(row.order_id || '').trim().toLowerCase()}|payer:${canonicalPayer(row.payer_number)}|amount:${amountKey(row.amount)}`;

      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(row);
    }

    const duplicateIds = [];
    for (const items of groups.values()) {
      if (items.length <= 1) continue;
      for (let i = 1; i < items.length; i += 1) {
        duplicateIds.push(items[i]._id);
      }
    }

    let modified = 0;
    if (apply && duplicateIds.length) {
      const result = await db.collection('merchant_verification_requests').updateMany(
        {
          _id: { $in: duplicateIds },
          status: { $in: ['pending', 'pending_sms', 'pending_review'] }
        },
        {
          $set: {
            status: 'rejected_duplicate',
            adminNote: 'One-time cleanup: duplicate pending merged under latest pending request',
            updatedAt: new Date()
          }
        }
      );
      modified = result.modifiedCount || 0;
    }

    const afterPending = await db.collection('merchant_verification_requests').countDocuments(pendingFilter);

    console.log(JSON.stringify({
      domain: website.domain,
      found: true,
      apply,
      beforePending,
      duplicateCandidates: duplicateIds.length,
      modified,
      afterPending,
      groups: groups.size
    }, null, 2));
  } finally {
    await client.close();
  }
}

run().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
