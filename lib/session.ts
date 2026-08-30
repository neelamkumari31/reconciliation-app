import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";

// Returns the logged-in user's id, or null if there is no valid session.
// Every API route must check this before touching any data.
export async function getUserId(): Promise<string | null> {
  const session = await getServerSession(authOptions);
  return (session?.user as any)?.id ?? null;
}
