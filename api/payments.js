import { ObjectId } from 'mongodb';
import { getDb } from './_db.js';
import { requireAdmin } from './_auth.js';
import { escapeRegex, handleCors, publicServerError, serializePayment } from './_utils.js';

export default async function handler(req, res) {
  if (handleCors(req, res, 'GET, PATCH, OPTIONS')) return;

  const admin = requireAdmin(req, res);
  if (!admin) return;

  try {
    const db = await getDb();

    if (req.method === 'GET') {
      const page = Math.max(Number(req.query.page || 1), 1);
      const limit = Math.min(Math.max(Number(req.query.limit || 25), 1), 100);
      const search = String(req.query.search || '').trim();
      const escapedSearch = escapeRegex(search);

      const filter = search
        ? {
            $or: [
              { transaction_id: { $regex: escapedSearch, $options: 'i' } },
              { sender: { $regex: escapedSearch, $options: 'i' } },
              { source_number: { $regex: escapedSearch, $options: 'i' } },
              { raw_message: { $regex: escapedSearch, $options: 'i' } }
            ]
          }
        : {};

      const [items, total, summary] = await Promise.all([
        db.collection('payments').find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).toArray(),
        db.collection('payments').countDocuments(filter),
        db.collection('payments').aggregate([
          { $match: filter },
          { $group: { _id: null, totalAmount: { $sum: '$amount' }, count: { $sum: 1 } } }
        ]).toArray()
      ]);

      return res.status(200).json({
        success: true,
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
        summary: summary[0] || { totalAmount: 0, count: 0 },
        items: items.map((item) => ({ ...serializePayment(item), _id: String(item._id) }))
      });
    }

    if (req.method === 'PATCH') {
      const { id, status } = req.body || {};
      const allowed = ['received', 'verified', 'rejected'];
      if (!ObjectId.isValid(id) || !allowed.includes(status)) {
        return res.status(400).json({ success: false, error: 'Valid id and status are required' });
      }

      await db.collection('payments').updateOne(
        { _id: new ObjectId(id) },
        { $set: { status, updatedAt: new Date() } }
      );
      return res.status(200).json({ success: true });
    }

    return res.status(405).json({ success: false, error: 'Method not allowed' });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, error: publicServerError(error) });
  }
}
