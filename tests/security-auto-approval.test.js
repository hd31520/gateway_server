import assert from 'node:assert/strict';
import test from 'node:test';
import { ObjectId } from 'mongodb';
import { autoApprovePendingMerchantVerification } from '../server/handlers/_merchant_verification.js';
import { computePlanTotalAmount } from '../server/handlers/_utils.js';
import { autoApprovePendingAdminPayment } from '../server/handlers/sms.js';

test('yearly packages bill 10 months and grant 12 months', () => {
  assert.equal(computePlanTotalAmount(1, 12), 600);
  assert.equal(computePlanTotalAmount(5, 12), 2000);
  assert.equal(computePlanTotalAmount(20, 12), 4000);
  assert.equal(computePlanTotalAmount(1, 1), 60);
});

test('auto-approves a pending billing request when matching admin SMS arrives', async () => {
  const clientId = new ObjectId();
  const websiteId = new ObjectId();
  const paymentId = new ObjectId();
  const requestId = new ObjectId();
  const now = new Date('2026-05-01T08:00:00.000Z');
  const db = new MemoryDb({
    payments: [{
      _id: paymentId,
      submittedBy: 'admin',
      transaction_id: 'TRX-BRAND',
      amount: 60,
      status: 'received',
      createdAt: now
    }],
    websites: [{
      _id: websiteId,
      clientId,
      domain: 'merchant.example',
      brandStatus: 'pending_review',
      paymentStatus: 'pending_review',
      monthlyFee: 60,
      createdAt: now
    }],
    billing_requests: [{
      _id: requestId,
      clientId,
      websiteId,
      domain: 'merchant.example',
      transaction_id: 'TRX-BRAND',
      amount: 60,
      months: 1,
      siteCount: 1,
      status: 'pending_review',
      createdAt: now
    }],
    subscription_renewals: []
  });

  const result = await autoApprovePendingAdminPayment(
    db,
    await db.collection('payments').findOne({ _id: paymentId }),
    now
  );

  assert.equal(result.status, 'approved');

  const website = await db.collection('websites').findOne({ _id: websiteId });
  assert.equal(website.brandStatus, 'active');
  assert.equal(website.paymentStatus, 'paid');
  assert.equal(website.androidAppEnabled, true);
  assert.ok(website.paidUntil instanceof Date);

  const request = await db.collection('billing_requests').findOne({ _id: requestId });
  assert.equal(request.status, 'approved');
  assert.equal(request.reviewedBy, 'admin_sms');

  const payment = await db.collection('payments').findOne({ _id: paymentId });
  assert.equal(payment.usedFor, 'brand_opening');
  assert.equal(String(payment.websiteId), String(websiteId));
});

test('records a helpful note when admin SMS TrxID matches but amount is wrong', async () => {
  const clientId = new ObjectId();
  const websiteId = new ObjectId();
  const paymentId = new ObjectId();
  const requestId = new ObjectId();
  const now = new Date('2026-05-01T08:00:00.000Z');
  const db = new MemoryDb({
    payments: [{
      _id: paymentId,
      submittedBy: 'admin',
      transaction_id: 'TRX-WRONG-AMOUNT',
      amount: 50,
      status: 'received',
      createdAt: now
    }],
    websites: [{
      _id: websiteId,
      clientId,
      domain: 'merchant.example',
      brandStatus: 'pending_review',
      paymentStatus: 'pending_review',
      createdAt: now
    }],
    billing_requests: [{
      _id: requestId,
      clientId,
      websiteId,
      domain: 'merchant.example',
      transaction_id: 'TRX-WRONG-AMOUNT',
      amount: 60,
      months: 1,
      siteCount: 1,
      status: 'pending_review',
      createdAt: now
    }],
    subscription_renewals: []
  });

  const result = await autoApprovePendingAdminPayment(
    db,
    await db.collection('payments').findOne({ _id: paymentId }),
    now
  );

  assert.equal(result, null);
  const request = await db.collection('billing_requests').findOne({ _id: requestId });
  assert.match(request.adminNote, /amount 50\.00 did not equal expected 60\.00/);
});

test('auto-approves pending merchant verification from the merchant owned SMS record', async () => {
  const clientId = new ObjectId();
  const websiteId = new ObjectId();
  const paymentId = new ObjectId();
  const requestId = new ObjectId();
  const now = new Date('2026-05-01T08:00:00.000Z');
  const db = new MemoryDb({
    payments: [{
      _id: paymentId,
      submittedBy: 'client',
      submittedByClientId: clientId,
      transaction_id: 'TRX-OWNED',
      amount: 500,
      status: 'received',
      createdAt: now
    }],
    merchant_verification_requests: [{
      _id: requestId,
      clientId,
      websiteId,
      domain: 'merchant.example',
      transaction_id: 'TRX-OWNED',
      amount: 500,
      order_id: 'ORDER-1',
      status: 'pending_sms',
      createdAt: now
    }],
    payment_verifications: []
  });

  const result = await autoApprovePendingMerchantVerification(
    db,
    await db.collection('payments').findOne({ _id: paymentId }),
    now
  );

  assert.equal(result.status, 'verified');
  assert.equal(result.transaction_id, 'TRX-OWNED');

  const payment = await db.collection('payments').findOne({ _id: paymentId });
  assert.equal(payment.status, 'verified');
  assert.equal(payment.usedFor, 'merchant_payment');
  assert.equal(String(payment.clientId), String(clientId));
  assert.equal(String(payment.websiteId), String(websiteId));

  const request = await db.collection('merchant_verification_requests').findOne({ _id: requestId });
  assert.equal(request.status, 'verified');
  assert.equal(String(request.paymentId), String(paymentId));

  const verification = await db.collection('payment_verifications').findOne({ transaction_id: 'TRX-OWNED' });
  assert.equal(String(verification.paymentId), String(paymentId));
  assert.equal(String(verification.clientId), String(clientId));
});

test('does not approve merchant verification from admin or already used SMS records', async () => {
  const clientId = new ObjectId();
  const websiteId = new ObjectId();
  const adminPaymentId = new ObjectId();
  const usedPaymentId = new ObjectId();
  const now = new Date('2026-05-01T08:00:00.000Z');
  const db = new MemoryDb({
    payments: [
      {
        _id: adminPaymentId,
        submittedBy: 'admin',
        clientId,
        transaction_id: 'TRX-ADMIN',
        amount: 60,
        status: 'received',
        createdAt: now
      },
      {
        _id: usedPaymentId,
        submittedBy: 'client',
        submittedByClientId: clientId,
        transaction_id: 'TRX-USED',
        amount: 700,
        status: 'verified',
        usedFor: 'brand_opening',
        createdAt: now
      }
    ],
    merchant_verification_requests: [
      {
        _id: new ObjectId(),
        clientId,
        websiteId,
        domain: 'merchant.example',
        transaction_id: 'TRX-ADMIN',
        amount: 60,
        status: 'pending_sms',
        createdAt: now
      },
      {
        _id: new ObjectId(),
        clientId,
        websiteId,
        domain: 'merchant.example',
        transaction_id: 'TRX-USED',
        amount: 700,
        status: 'pending_sms',
        createdAt: now
      }
    ],
    payment_verifications: []
  });

  assert.equal(
    await autoApprovePendingMerchantVerification(db, await db.collection('payments').findOne({ _id: adminPaymentId }), now),
    null
  );
  assert.equal(
    await autoApprovePendingMerchantVerification(db, await db.collection('payments').findOne({ _id: usedPaymentId }), now),
    null
  );
  assert.equal(db.collection('payment_verifications').items.length, 0);
});

class MemoryDb {
  constructor(seed = {}) {
    this.collections = new Map(
      Object.entries(seed).map(([name, items]) => [name, new MemoryCollection(items)])
    );
  }

  collection(name) {
    if (!this.collections.has(name)) this.collections.set(name, new MemoryCollection());
    return this.collections.get(name);
  }
}

class MemoryCollection {
  constructor(items = []) {
    this.items = items.map((item) => ({ ...item }));
  }

  async findOne(query) {
    return this.items.find((item) => matches(item, query)) || null;
  }

  find(query) {
    let items = this.items.filter((item) => matches(item, query));
    return {
      sort(sortSpec = {}) {
        const [[field, direction] = []] = Object.entries(sortSpec);
        if (field) {
          items = [...items].sort((left, right) => compareValues(left[field], right[field]) * direction);
        }
        return this;
      },
      limit(count) {
        items = items.slice(0, count);
        return this;
      },
      async toArray() {
        return items;
      }
    };
  }

  async findOneAndUpdate(query, update) {
    const item = this.items.find((entry) => matches(entry, query));
    if (!item) return null;
    applyUpdate(item, update);
    return item;
  }

  async updateOne(query, update, options = {}) {
    const item = this.items.find((entry) => matches(entry, query));
    if (!item) {
      if (!options.upsert) return { matchedCount: 0, modifiedCount: 0 };
      const inserted = { ...query, ...(update.$setOnInsert || {}), ...(update.$set || {}) };
      if (!inserted._id) inserted._id = new ObjectId();
      this.items.push(inserted);
      return { matchedCount: 0, modifiedCount: 0, upsertedId: inserted._id };
    }
    applyUpdate(item, update);
    return { matchedCount: 1, modifiedCount: 1 };
  }

  async insertOne(doc) {
    const item = { ...doc, _id: doc._id || new ObjectId() };
    this.items.push(item);
    return { insertedId: item._id };
  }
}

function matches(item, query = {}) {
  return Object.entries(query).every(([field, condition]) => {
    if (field === '$and') return condition.every((part) => matches(item, part));
    if (field === '$or') return condition.some((part) => matches(item, part));
    return matchesCondition(item[field], condition);
  });
}

function matchesCondition(value, condition) {
  if (isPlainObject(condition)) {
    return Object.entries(condition).every(([operator, expected]) => {
      if (operator === '$in') return expected.some((item) => isEqual(value, item));
      if (operator === '$exists') return (value !== undefined) === expected;
      if (operator === '$ne') return !isEqual(value, expected);
      return isEqual(value?.[operator], expected);
    });
  }
  return isEqual(value, condition);
}

function applyUpdate(item, update = {}) {
  Object.assign(item, update.$set || {});
}

function isEqual(left, right) {
  return String(left) === String(right);
}

function isPlainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date) && !(value instanceof ObjectId);
}

function compareValues(left, right) {
  if (left instanceof Date && right instanceof Date) return left.getTime() - right.getTime();
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}
