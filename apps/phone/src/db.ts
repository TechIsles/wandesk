// Phone — client-side data layer. The screen history is stored in the db, so a cold start resumes the last screen.
import { db } from './wandesk/db';
import type { Screen } from './lib/screen';

export const saveScreen = (appId: string, s: Screen) =>
  db(appId, 'INSERT INTO app_phone_screens (content, options) VALUES (?, ?)', [s.content, JSON.stringify(s.options || [])]);

export async function loadLastScreen(appId: string): Promise<Screen | null> {
  const res = await db(appId, 'SELECT content, options FROM app_phone_screens ORDER BY id DESC LIMIT 1');
  const row = res.rows && res.rows[0];
  if (!row || !row.content) return null;
  let options: { text: string }[] = [];
  try { options = JSON.parse(String(row.options || '[]')); } catch { options = []; }
  return { content: String(row.content), options };
}
