// The frontend calls the function URL directly (Hosting rewrites don't support africa-south1),
// so browsers need CORS. This only restricts browsers; auth is still enforced on every request.
const ALLOWED_ORIGINS = [
  /^https:\/\/curecloud1(--[a-z0-9-]+)?\.web\.app$/, // live site + Hosting preview channels
  /^https:\/\/curecloud1\.firebaseapp\.com$/,
  /^http:\/\/(localhost|127\.0\.0\.1):\d+$/, // Vite dev server
];

const isAllowed = (origin) => ALLOWED_ORIGINS.some((re) => re.test(origin));

export function cors(req, res, next) {
  const origin = req.get("origin");
  res.vary("Origin");
  if (origin && isAllowed(origin)) {
    res.set("Access-Control-Allow-Origin", origin);
  }
  if (req.method === "OPTIONS") {
    if (!origin || !isAllowed(origin)) return res.status(403).end();
    res.set({
      "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Authorization, Content-Type",
      "Access-Control-Max-Age": "7200", // browsers cap preflight caching at ~2h
    });
    return res.status(204).end();
  }
  next();
}
