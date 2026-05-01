import { ObjectId } from 'mongodb';
import { toObjectId } from './_billing.js';
import { serializeMerchantVerification } from './_utils.js';

export async function createMerchantVerification(db, data = {}) {
  const now = new Date();
  const doc = {
    clientId: toObjectId(data.clientId),
    websiteId: toObjectId(data.websiteId),
    name: data.name || '',
    phone: data.phone || '',
    nid: data.nid || '',
    address: data.address || '',
    status: data.status || 'pending',
    createdAt: now,
    updatedAt: now
  };

  const result = await db.collection('merchant_verifications').insertOne(doc);
  doc._id = result.insertedId;
  return serializeMerchantVerification(doc);
}

export async function getMerchantVerification(db, id) {
  const oid = toObjectId(id);
  if (!oid) return null;
  const doc = await db.collection('merchant_verifications').findOne({ _id: oid });
  return doc ? serializeMerchantVerification(doc) : null;
}
