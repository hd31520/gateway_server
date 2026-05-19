import { ObjectId } from 'mongodb';
import { sendSmsViaGateway, sendAndroidNotification } from './_utils.js';
import { getDb } from './_db.js';

// Store pending payments in memory (use Redis in production)
const pendingPayments = new Map();

/**
 * POST /api/payment/gateway/initiate
 * Initiate payment flow - trigger Android notification and SMS verification
 */
export async function initiatePayment(req, res) {
  try {
    const { paymentMethod, senderPhone, receiverPhone, amount } = req.body;

    function normalizePhone(raw) {
      let s = String(raw || '').trim();
      s = s.replace(/[^0-9+]/g, '');
      if (s.startsWith('+880')) s = '0' + s.slice(4);
      if (s.startsWith('880')) s = '0' + s.slice(3);
      if (!s.startsWith('0') && s.length === 10 && s.startsWith('1')) s = '0' + s;
      return s;
    }

    const normSender = normalizePhone(senderPhone || '');
    const normReceiver = normalizePhone(receiverPhone || '');

    // Validation: require paymentMethod and amount; senderPhone/receiverPhone can be provided later
    if (!paymentMethod || !amount) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    if (amount <= 0) {
      return res.status(400).json({ error: 'Invalid amount' });
    }

    const db = getDb();
    const paymentsCollection = db.collection('payments');

    // Create payment record
    const payment = {
      _id: new ObjectId(),
      paymentMethod,
      senderPhone: normSender,
      receiverPhone: normReceiver,
      amount,
      status: 'pending',
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 2 * 60 * 1000), // 2 minutes
      smsVerified: false,
      smsCode: generateSmsCode(),
    };

    await paymentsCollection.insertOne(payment);

    // Store in memory for quick lookup
    pendingPayments.set(payment._id.toString(), payment);

    // Send Android notification with payment details
    await sendAndroidNotification({
      title: `Payment Incoming - ${paymentMethod.toUpperCase()}`,
      body: `Send ৳${amount} to ${normReceiver}`,
      data: {
        paymentId: payment._id.toString(),
        senderPhone: normSender,
        receiverPhone: normReceiver,
        amount,
        smsCode: payment.smsCode,
      },
    });

    // Send verification SMS (in production, the SMS contains the code)
    await sendSmsViaGateway({
      number: normSender,
      message: `Payment Code: ${payment.smsCode}. Send ৳${amount} to ${normReceiver}. Valid for 2 minutes.`,
    });

    return res.status(200).json({
      success: true,
      paymentId: payment._id.toString(),
      message: 'Payment initiated. Check your phone for SMS.',
    });
  } catch (error) {
    console.error('Error initiating payment:', error);
    return res.status(500).json({ error: 'Failed to initiate payment' });
  }
}

/**
 * POST /api/payment/gateway/verify-sms
 * Verify SMS from Android (contains sender phone, amount, SMS code)
 */
export async function verifySms(req, res) {
  try {
    const { paymentId, smsText, detectedAmount, detectedPhone } = req.body;

    if (!paymentId || !smsText) {
      return res.status(400).json({ error: 'Missing paymentId or smsText' });
    }

    const db = getDb();
    const paymentsCollection = db.collection('payments');

    // Find payment
    const payment = await paymentsCollection.findOne({
      _id: new ObjectId(paymentId),
    });

    if (!payment) {
      return res.status(404).json({ error: 'Payment not found' });
    }

    if (payment.status !== 'pending') {
      return res.status(400).json({ error: 'Payment is no longer pending' });
    }

    // Check expiry
    if (new Date() > payment.expiresAt) {
      await paymentsCollection.updateOne(
        { _id: payment._id },
        { $set: { status: 'expired' } }
      );
      return res.status(400).json({ error: 'Payment expired' });
    }

    // Verify: amount and phone match
    const amountMatches = parseFloat(detectedAmount) === payment.amount;
    const phoneMatches =
      detectedPhone === payment.senderPhone ||
      smsText.includes(payment.senderPhone);

    if (!amountMatches || !phoneMatches) {
      return res.status(400).json({
        error: 'SMS details do not match payment',
        details: { amountMatches, phoneMatches },
      });
    }

    // Create a transaction id and mark as verified
    const transactionId = new ObjectId().toString();
    await paymentsCollection.updateOne(
      { _id: payment._id },
      {
        $set: {
          status: 'verified',
          smsVerified: true,
          smsText,
          verifiedAt: new Date(),
          transactionId,
        },
      }
    );

    // Remove from memory cache
    pendingPayments.delete(paymentId);

    // Emit success to connected clients (via WebSocket in real implementation)
    // For now, return success
    return res.status(200).json({
      success: true,
      message: 'Payment verified successfully',
      paymentId,
      transactionId,
    });
  } catch (error) {
    console.error('Error verifying SMS:', error);
    return res.status(500).json({ error: 'Failed to verify SMS' });
  }
}

/**
 * GET /api/payment/gateway/status/:paymentId
 * Get payment status (polling for success)
 */
export async function getPaymentStatus(req, res) {
  try {
    const { paymentId } = req.params;

    if (!paymentId) {
      return res.status(400).json({ error: 'Missing paymentId' });
    }

    const db = getDb();
    const paymentsCollection = db.collection('payments');

    const payment = await paymentsCollection.findOne({
      _id: new ObjectId(paymentId),
    });

    if (!payment) {
      return res.status(404).json({ error: 'Payment not found' });
    }

    // Check if expired
    if (payment.status === 'pending' && new Date() > payment.expiresAt) {
      await paymentsCollection.updateOne(
        { _id: payment._id },
        { $set: { status: 'expired' } }
      );
      payment.status = 'expired';
    }

    return res.status(200).json({
      paymentId,
      status: payment.status, // 'pending' | 'verified' | 'expired'
      amount: payment.amount,
      senderPhone: payment.senderPhone,
      receiverPhone: payment.receiverPhone,
      smsVerified: payment.smsVerified,
    });
  } catch (error) {
    console.error('Error fetching payment status:', error);
    return res.status(500).json({ error: 'Failed to fetch status' });
  }
}

/**
 * Helper: Generate a random 4-6 digit SMS code
 */
function generateSmsCode() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

/**
 * POST /api/payment/gateway/cancel/:paymentId
 * Cancel a pending payment
 */
export async function cancelPayment(req, res) {
  try {
    const { paymentId } = req.params;

    if (!paymentId) {
      return res.status(400).json({ error: 'Missing paymentId' });
    }

    const db = getDb();
    const paymentsCollection = db.collection('payments');

    const result = await paymentsCollection.updateOne(
      { _id: new ObjectId(paymentId), status: 'pending' },
      { $set: { status: 'cancelled', cancelledAt: new Date() } }
    );

    if (result.matchedCount === 0) {
      return res.status(404).json({ error: 'Payment not found or not pending' });
    }

    // Remove from memory cache
    pendingPayments.delete(paymentId);

    return res.status(200).json({
      success: true,
      message: 'Payment cancelled',
    });
  } catch (error) {
    console.error('Error cancelling payment:', error);
    return res.status(500).json({ error: 'Failed to cancel payment' });
  }
}
