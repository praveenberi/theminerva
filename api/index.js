// Vercel serverless function: every /api/* request is rewritten here (see vercel.json).
// The API is compiled to apps/api/dist by the build step (scripts/vercel-build.sh).
module.exports = require('../apps/api/dist/serverless');
