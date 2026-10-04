import { NextRequest, NextResponse } from 'next/server';
import { debugCifra, normalizeCifraUrl } from '@/lib/cifraclub';

// Diagnóstico (protegido pelo login do middleware): mostra o que o acesso
// direto e a raspagem do Serper devolvem para uma página do Cifra Club.
export async function GET(req: NextRequest) {
  const url = normalizeCifraUrl(req.nextUrl.searchParams.get('url') ?? '');
  if (!url) return NextResponse.json({ error: 'Passe ?url=<página do Cifra Club>' }, { status: 400 });
  return NextResponse.json(await debugCifra(url));
}
