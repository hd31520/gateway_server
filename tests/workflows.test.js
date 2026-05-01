/**
 * Comprehensive Workflow Tests for Payment Gateway
 * Tests all major flows: brand creation, subscription, merchant verification, etc.
 */

const workflows = {
  // Test 1: Admin PATCH endpoints
  adminBrandUpdate: {
    endpoint: 'PATCH /api/admin',
    body: {
      action: 'brand',
      websiteId: 'WEBSITE_ID',
      brandStatus: 'active',
      adminNote: 'Test approval'
    },
    expectedStatus: 200,
    expectedFields: ['success', 'website']
  },

  adminUserUpdate: {
    endpoint: 'PATCH /api/admin',
    body: {
      action: 'user',
      clientId: 'CLIENT_ID',
      status: 'active',
      adminNote: 'Account approved'
    },
    expectedStatus: 200,
    expectedFields: ['success', 'client']
  },

  adminMerchantVerificationUpdate: {
    endpoint: 'PATCH /api/admin',
    body: {
      action: 'merchantVerification',
      id: 'VERIFICATION_ID', // Accepts both 'id' and 'verificationId'
      status: 'manual_approved',
      adminNote: 'Verified'
    },
    expectedStatus: 200,
    expectedFields: ['success', 'verification']
  },

  // Test 2: SMS Payment Auto-Approval
  smsAutoApproval: {
    endpoint: 'POST /api/sms',
    body: {
      transaction_id: 'TRX123',
      amount: 100,
      sender_name: 'Admin',
      raw_message: 'Payment received'
    },
    expectedFlow: [
      'Payment saved',
      'Auto-approve pending brand if TrxID matches',
      'Auto-approve pending merchant verification if TrxID matches'
    ]
  },

  // Test 3: Brand Creation with Pending State
  brandCreation: {
    endpoint: 'POST /api/client/websites',
    body: {
      domain: 'test.com',
      transaction_id: 'TRX123',
      amount: 100
    },
    expectedFlow: [
      'If SMS TrxID matches immediately → activate brand',
      'If no matching SMS → create pending billing request'
    ]
  },

  // Test 4: Subscription Renewal
  subscriptionRenewal: {
    endpoint: 'POST /api/client/subscription',
    body: {
      websiteId: 'WEBSITE_ID',
      transaction_id: 'TRX456',
      amount: 100
    },
    expectedFlow: [
      'If SMS TrxID matches → activate subscription',
      'If no matching SMS → save pending request for later auto-approval'
    ]
  },

  // Test 5: Merchant Verification
  merchantVerification: {
    endpoint: 'POST /api/merchant/verify',
    body: {
      domain: 'test.com',
      transaction_id: 'TRX789',
      amount: 50
    },
    expectedFlow: [
      'If SMS TrxID matches → create verified record',
      'If no matching SMS → save pending request'
    ]
  },

  // Test 6: Admin Dashboard Load
  adminDashboard: {
    endpoint: 'GET /api/admin',
    expectedFields: [
      'success',
      'admin',
      'clients',
      'brands',
      'billingRequests',
      'payments',
      'accountHistory',
      'merchantVerifications',
      'devices',
      'tickets',
      'summary'
    ]
  }
};

export default workflows;
