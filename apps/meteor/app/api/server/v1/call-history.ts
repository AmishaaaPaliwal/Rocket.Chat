import { CallHistoryItemSchema, CallHistoryItemStateSchema, IMediaCallsSchema, ICallHistoryItemSchema } from '@rocket.chat/core-typings';
import { CallHistory, MediaCalls } from '@rocket.chat/models';
import {
	createValidatorFor,
	BadRequestErrorResponseSchema,
	createSuccessResponseSchema,
	ForbiddenErrorResponseSchema,
	PaginatedRequestSchema,
	PaginatedResultSchema,
	UnauthorizedErrorResponseSchema,
	NotFoundErrorResponseSchema,
} from '@rocket.chat/rest-typings';
import { escapeRegExp } from '@rocket.chat/string-helpers';
import * as z from 'zod';

import { ensureArray } from '../../../../lib/utils/arrayUtils';
import type { ExtractRoutesFromAPI } from '../ApiClass';
import { API } from '../api';
import { getPaginationItems } from '../helpers/getPaginationItems';

const callHistoryEndpoints = API.v1
	.get(
		'call-history.list',
		{
			authRequired: true,
			query: createValidatorFor(
				z
					.object({
						filter: z.string().optional(),
						direction: ICallHistoryItemSchema.shape.direction.optional(),
						state: z.union([CallHistoryItemStateSchema, z.array(CallHistoryItemStateSchema)]).optional(),
					})
					.and(PaginatedRequestSchema),
			),
			response: {
				200: createValidatorFor(
					createSuccessResponseSchema(
						z
							.object({
								items: z.array(CallHistoryItemSchema),
							})
							.and(PaginatedResultSchema),
					),
				),
				400: createValidatorFor(BadRequestErrorResponseSchema),
				401: createValidatorFor(UnauthorizedErrorResponseSchema),
				403: createValidatorFor(ForbiddenErrorResponseSchema),
			},
		},
		async function action() {
			const { offset, count } = await getPaginationItems(this.queryParams);
			const { sort } = await this.parseJsonQuery();

			const { direction, state, filter } = this.queryParams;

			const filterText = typeof filter === 'string' && filter.trim();

			const stateFilter = state && ensureArray(state);
			const query = {
				uid: this.userId,
				...(direction && { direction }),
				...(stateFilter?.length && { state: { $in: stateFilter } }),
				...(filterText && {
					$or: [
						{
							external: false,
							contactName: { $regex: escapeRegExp(filterText), $options: 'i' },
						},
						{
							external: false,
							contactUsername: { $regex: escapeRegExp(filterText), $options: 'i' },
						},
						{
							external: true,
							contactExtension: { $regex: escapeRegExp(filterText), $options: 'i' },
						},
					],
				}),
			};

			const { cursor, totalCount } = CallHistory.findPaginated(query, {
				sort: sort || { ts: -1 },
				skip: offset,
				limit: count,
			});
			const [items, total] = await Promise.all([cursor.toArray(), totalCount]);

			return API.v1.success({
				items,
				count: items.length,
				offset,
				total,
			});
		},
	)
	.get(
		'call-history.info',
		{
			authRequired: true,
			query: createValidatorFor(z.union([z.object({ historyId: z.string() }), z.object({ callId: z.string() })])),
			response: {
				200: createValidatorFor(
					createSuccessResponseSchema(
						z.object({
							item: CallHistoryItemSchema,
							call: IMediaCallsSchema.optional(),
						}),
					),
				),
				400: createValidatorFor(BadRequestErrorResponseSchema),
				401: createValidatorFor(UnauthorizedErrorResponseSchema),
				403: createValidatorFor(ForbiddenErrorResponseSchema),
				404: createValidatorFor(NotFoundErrorResponseSchema),
			},
		},
		async function action() {
			const { historyId, callId } = this.queryParams as Record<string, never> & typeof this.queryParams;

			if (!historyId && !callId) {
				return API.v1.failure();
			}

			const item = await (historyId
				? CallHistory.findOneByIdAndUid(historyId, this.userId)
				: CallHistory.findOneByCallIdAndUid(callId, this.userId));

			if (!item) {
				return API.v1.notFound();
			}

			if (item.type === 'media-call' && item.callId) {
				const call = await MediaCalls.findOneById(item.callId);
				if (call) {
					return API.v1.success({
						item,
						call,
					});
				}
			}

			return API.v1.success({ item });
		},
	);

declare module '@rocket.chat/rest-typings' {
	// eslint-disable-next-line @typescript-eslint/naming-convention, @typescript-eslint/no-empty-interface
	interface Endpoints extends ExtractRoutesFromAPI<typeof callHistoryEndpoints> {}
}
