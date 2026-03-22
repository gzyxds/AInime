import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { characters } from "@/lib/db/schema";
import { eq } from "drizzle-orm";

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string; characterId: string }> }
) {
  const { characterId } = await params;
  const body = (await request.json()) as Partial<{
    name: string;
    description: string;
    visualHint: string;
  }>;

  const [updated] = await db
    .update(characters)
    .set(body)
    .where(eq(characters.id, characterId))
    .returning();

  return NextResponse.json(updated);
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string; characterId: string }> }
) {
  const { characterId } = await params;
  await db.delete(characters).where(eq(characters.id, characterId));
  return new NextResponse(null, { status: 204 });
}
