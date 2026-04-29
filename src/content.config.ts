import { defineCollection } from 'astro:content';
import { glob } from 'astro/loaders';
import { z } from 'astro/zod';

const blog = defineCollection({
	loader: glob({ base: './src/content/blog', pattern: '**/*.{md,mdx}' }),
	schema: ({ image }) =>
		z.object({
			title: z.string(),
			description: z.string(),
			pubDate: z.coerce.date(),
			updatedDate: z.coerce.date().optional(),
			heroImage: z.optional(image()),
		}),
});

const projects = defineCollection({
	loader: glob({ base: './src/content/projects', pattern: '**/*.{md,mdx}' }),
	schema: z.object({
		title: z.string(),
		description: z.string(),
		tags: z.array(z.string()),
		category: z.enum(['Security & Platform', 'AI Tooling', 'Developer Tools', 'Pipeline Validation']),
		featured: z.boolean().default(false),
		order: z.number().default(99),
		links: z.array(z.object({
			label: z.string(),
			url: z.string(),
		})).default([]),
		visibility: z.enum(['public', 'private']).default('public'),
	}),
});

export const collections = { blog, projects };
