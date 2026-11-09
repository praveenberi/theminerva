process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = 'postgresql://postgres:postgres@localhost:5433/minerva_test?schema=public';
process.env.JWT_ACCESS_SECRET = 'test-access-secret-0123456789-abcdefghijkl';
process.env.JWT_REFRESH_SECRET = 'test-refresh-secret-0123456789-abcdefghijk';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_secret';
process.env.RAZORPAY_WEBHOOK_SECRET = 'rzp_test_secret';
delete process.env.STRIPE_SECRET_KEY; delete process.env.RAZORPAY_KEY_ID; delete process.env.RESEND_API_KEY; delete process.env.ANTHROPIC_API_KEY;
