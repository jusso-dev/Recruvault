export async function GET() {
  return Response.json(
    { status: "ok", check: "liveness" },
    { headers: { "Cache-Control": "no-store" } },
  );
}
