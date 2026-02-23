import { Hono } from 'hono';
import { handleFeedbackIngest } from './feedback';
import type { Env } from '../index';

const router = new Hono<{ Bindings: Env }>();

// POST /api/v1/feedback/ingest
router.post('/ingest', handleFeedbackIngest);

export { router as feedbackRouter };
