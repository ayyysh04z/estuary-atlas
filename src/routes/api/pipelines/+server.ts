import { json } from '@sveltejs/kit';
import { PIPELINES } from '$lib/pipelines';

export const GET = () => json(PIPELINES);
