import { serializableDate } from '@rocket.chat/core-typings';
import { Subscriptions, Users } from '@rocket.chat/models';
import {
	createSuccessResponseSchema,
	createValidatorFor,
	BadRequestErrorResponseSchema,
	ForbiddenErrorResponseSchema,
	UnauthorizedErrorResponseSchema,
	VoidSuccessResponseSchema,
} from '@rocket.chat/rest-typings';
import ExpiryMap from 'expiry-map';
import * as z from 'zod';

import { canAccessRoomIdAsync } from '../../../authorization/server/functions/canAccessRoom';
import { hasPermissionAsync } from '../../../authorization/server/functions/hasPermission';
import { handleSuggestedGroupKey } from '../../../e2e/server/functions/handleSuggestedGroupKey';
import { provideUsersSuggestedGroupKeys } from '../../../e2e/server/functions/provideUsersSuggestedGroupKeys';
import { resetRoomKey } from '../../../e2e/server/functions/resetRoomKey';
import { getUsersOfRoomWithoutKeyMethod } from '../../../e2e/server/methods/getUsersOfRoomWithoutKey';
import { setRoomKeyIDMethod } from '../../../e2e/server/methods/setRoomKeyID';
import { setUserPublicAndPrivateKeysMethod } from '../../../e2e/server/methods/setUserPublicAndPrivateKeys';
import { updateGroupKey } from '../../../e2e/server/methods/updateGroupKey';
import { settings } from '../../../settings/server';
import type { ExtractRoutesFromAPI } from '../ApiClass';
import { API } from '../api';

// After 10s the room lock will expire, meaning that if for some reason the process never completed
// The next reset will be available 10s after
const LockMap = new ExpiryMap<string, boolean>(10000);

const e2eEndpoints = API.v1
	.post(
		'e2e.setRoomKeyID',
		{
			authRequired: true,
			body: createValidatorFor(
				z.object({
					rid: z.string(),
					keyID: z.string(),
				}),
			),
			response: {
				200: createValidatorFor(VoidSuccessResponseSchema),
				400: createValidatorFor(BadRequestErrorResponseSchema),
				401: createValidatorFor(UnauthorizedErrorResponseSchema),
			},
		},
		async function action() {
			const { rid, keyID } = this.bodyParams;

			await setRoomKeyIDMethod(this.userId, rid, keyID);

			return API.v1.success();
		},
	)
	.get(
		'e2e.fetchMyKeys',
		{
			authRequired: true,
			response: {
				200: createValidatorFor(
					createSuccessResponseSchema(
						z.union([
							z.object({
								public_key: z.string(),
								private_key: z.string(),
							}),
							z.record(z.any(), z.any()),
						]),
					),
				),
			},
		},
		async function action() {
			const result = await Users.fetchKeysByUserId(this.userId);

			return API.v1.success(result);
		},
	)
	.get(
		'e2e.getUsersOfRoomWithoutKey',
		{
			authRequired: true,
			query: createValidatorFor(
				z.object({
					rid: z.string(),
				}),
			),
			response: {
				200: createValidatorFor(
					createSuccessResponseSchema(
						z.object({
							users: z.array(
								z.object({
									_id: z.string(),
									e2e: z
										.object({
											private_key: z.string(),
											public_key: z.string(),
										})
										.optional(),
								}),
							),
						}),
					),
				),
			},
		},
		async function action() {
			const { rid } = this.queryParams;

			const result = await getUsersOfRoomWithoutKeyMethod(this.userId, rid);

			return API.v1.success(result);
		},
	)
	.post(
		// Sets the end-to-end encryption keys for the authenticated user
		'e2e.setUserPublicAndPrivateKeys',
		{
			authRequired: true,
			body: createValidatorFor(
				z.object({
					public_key: z.string(),
					private_key: z.string(),
					force: z.boolean().optional(),
				}),
			),
			response: {
				200: createValidatorFor(VoidSuccessResponseSchema),
				400: createValidatorFor(BadRequestErrorResponseSchema),
			},
		},
		async function action() {
			const { public_key: publicKey, private_key: privateKey, force } = this.bodyParams;

			await setUserPublicAndPrivateKeysMethod(this.userId, {
				public_key: publicKey,
				private_key: privateKey,
				force,
			});

			return API.v1.success();
		},
	)
	.post(
		// Updates the end-to-end encryption key for a user on a room
		'e2e.updateGroupKey',
		{
			authRequired: true,
			body: createValidatorFor(
				z.object({
					uid: z.string(),
					rid: z.string(),
					key: z.string(),
				}),
			),
			response: {
				200: createValidatorFor(VoidSuccessResponseSchema),
			},
		},
		async function action() {
			const { uid, rid, key } = this.bodyParams;

			await updateGroupKey(rid, uid, key, this.userId);

			return API.v1.success();
		},
	)
	.post(
		'e2e.acceptSuggestedGroupKey',
		{
			authRequired: true,
			body: createValidatorFor(
				z.object({
					rid: z.string(),
				}),
			),
			response: {
				200: createValidatorFor(VoidSuccessResponseSchema),
			},
		},
		async function action() {
			const { rid } = this.bodyParams;

			await handleSuggestedGroupKey('accept', rid, this.userId, 'e2e.acceptSuggestedGroupKey');

			return API.v1.success();
		},
	)
	.post(
		'e2e.rejectSuggestedGroupKey',
		{
			authRequired: true,
			body: createValidatorFor(
				z.object({
					rid: z.string(),
				}),
			),
			response: {
				200: createValidatorFor(VoidSuccessResponseSchema),
			},
		},
		async function action() {
			const { rid } = this.bodyParams;

			await handleSuggestedGroupKey('reject', rid, this.userId, 'e2e.rejectSuggestedGroupKey');

			return API.v1.success();
		},
	)
	.get(
		'e2e.fetchUsersWaitingForGroupKey',
		{
			authRequired: true,
			query: createValidatorFor(
				z.object({
					roomIds: z.array(z.string()),
				}),
			),
			response: {
				200: createValidatorFor(
					createSuccessResponseSchema(
						z.object({
							usersWaitingForE2EKeys: z.record(
								z.string(),
								z.array(
									z.object({
										_id: z.string(),
										public_key: z.string(),
									}),
								),
							),
						}),
					),
				),
			},
		},
		async function action() {
			if (!settings.get('E2E_Enable')) {
				return API.v1.success({ usersWaitingForE2EKeys: {} });
			}

			const { roomIds = [] } = this.queryParams;
			const usersWaitingForE2EKeys = (await Subscriptions.findUsersWithPublicE2EKeyByRids(roomIds, this.userId).toArray()).reduce<
				Record<string, { _id: string; public_key: string }[]>
			>((acc, { rid, users }) => ({ [rid]: users, ...acc }), {});

			return API.v1.success({
				usersWaitingForE2EKeys,
			});
		},
	)
	.post(
		'e2e.provideUsersSuggestedGroupKeys',
		{
			authRequired: true,
			body: createValidatorFor(
				z.object({
					usersSuggestedGroupKeys: z.record(
						z.string(),
						z.array(
							z.object({
								_id: z.string(),
								key: z.string(),
								oldKeys: z
									.array(
										z.object({
											e2eKeyId: z.string(),
											ts: serializableDate,
											E2EKey: z.string(),
										}),
									)
									.optional(),
							}),
						),
					),
				}),
			),
			response: {
				200: createValidatorFor(VoidSuccessResponseSchema),
			},
		},
		async function action() {
			if (!settings.get('E2E_Enable')) {
				return API.v1.success();
			}

			await provideUsersSuggestedGroupKeys(this.userId, this.bodyParams.usersSuggestedGroupKeys);

			return API.v1.success();
		},
	)
	.post(
		// This should have permissions
		'e2e.resetRoomKey',
		{
			authRequired: true,
			body: createValidatorFor(
				z.object({
					rid: z.string(),
					e2eKey: z.string(),
					e2eKeyId: z.string(),
				}),
			),
			response: {
				200: createValidatorFor(VoidSuccessResponseSchema),
				400: createValidatorFor(BadRequestErrorResponseSchema),
				403: createValidatorFor(ForbiddenErrorResponseSchema),
			},
		},
		async function action() {
			const { rid, e2eKey, e2eKeyId } = this.bodyParams;
			if (!(await hasPermissionAsync(this.userId, 'toggle-room-e2e-encryption', rid))) {
				return API.v1.forbidden();
			}
			if (LockMap.has(rid)) {
				throw new Error('error-e2e-key-reset-in-progress');
			}

			LockMap.set(rid, true);

			if (!(await canAccessRoomIdAsync(rid, this.userId))) {
				throw new Error('error-not-allowed');
			}

			try {
				await resetRoomKey(rid, this.userId, e2eKey, e2eKeyId);
				return API.v1.success();
			} catch (e) {
				console.error(e);
				return API.v1.failure('error-e2e-key-reset-failed');
			} finally {
				LockMap.delete(rid);
			}
		},
	);

declare module '@rocket.chat/rest-typings' {
	// eslint-disable-next-line @typescript-eslint/naming-convention, @typescript-eslint/no-empty-interface
	interface Endpoints extends ExtractRoutesFromAPI<typeof e2eEndpoints> {}
}
