/** Liveness probe for load balancers and container orchestrators. Does not touch the API. */
export const dynamic = 'force-dynamic';

export function GET() {
  return Response.json({ status: 'ok', app: 'customer-web', time: new Date().toISOString() }, { headers: { 'cache-control': 'no-store' } });
}
