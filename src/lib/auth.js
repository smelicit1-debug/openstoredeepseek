const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'os-dev-jwt-secret';

// Middleware: require a valid JWT token
function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authentication required.' });
  }
  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token.' });
  }
}

// Middleware: optional auth (populates req.user if token present, doesn't fail)
function optionalAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    try {
      req.user = jwt.verify(authHeader.split(' ')[1], JWT_SECRET);
    } catch {
      // ignore invalid token
    }
  }
  next();
}

// Generate a JWT for a user
function generateToken(user) {
  return jwt.sign(
    { id: user.id, email: user.email, tier: user.tier || 'free' },
    JWT_SECRET,
    { expiresIn: '7d' }
  );
}

module.exports = { requireAuth, optionalAuth, generateToken };
