/* eslint-disable no-param-reassign */
import Keyring from '@polkadot/keyring';
import { AnyNumber } from '@polkadot/types/types';
// eslint-disable-next-line import/no-extraneous-dependencies
import { uniqueNamesGenerator, names, colors } from 'unique-names-generator';
import { Bytes } from '@polkadot/types';
import { hexToU8a, u8aToHex, u8aWrapBytes } from '@polkadot/util';
import { GraphKeyType } from '@dsnp/graph-sdk';
import { getAddGraphKeyPayload, getCurrentPublicGraphKey } from '../scaffolding/graph';
import { AddProviderPayload, ExtrinsicHelper } from '../scaffolding/extrinsicHelpers';
import { Sr25519Signature, signPayloadSr25519 } from '../scaffolding/helpers';
import { ChainUser } from './types';

const DEFAULT_SCHEMAS = [5, 7, 8, 9, 10];
const keyring = new Keyring({ type: 'sr25519' });
const wellKnownGraphKeypair = {
  publicKey: '0x0514f63edc89d414061bf451cc99b1f2b43fac920c351be60774559a31523c75',
  privateKey: '0x1c15b6d1af4716615a4eb83a2dfba3284e1c0a199603572e7b95c164f7ad90e3',
};

async function resolveUsersFromChain(users: ChainUser[]): Promise<void> {
  const addresses = users.map((u) => u.keypair.address);
  const allMsas = await ExtrinsicHelper.apiPromise.query.msa.publicKeyToMsaId.multi([...addresses]);
  addresses.forEach((_, index) => {
    if (!allMsas[index].isNone) {
      users[index].msaId = allMsas[index].unwrap();
    }
  });

  const resolvedUsers = users.filter((u) => u?.msaId);
  const allHandles = await ExtrinsicHelper.apiPromise.query.handles.msaIdToDisplayName(resolvedUsers.map((u) => u.msaId));
  resolvedUsers.forEach((u, i) => {
    if (allHandles[i].isSome) {
      // eslint-disable-next-line no-param-reassign
      u.handle = allHandles[i].unwrap().toString();
    }
  });
  console.log(`Resolved ${users.filter((u) => u?.msaId).length} existing user accounts on-chain`);
}

export async function initializeLocalUsers(baseSeed: string, numUsers: number): Promise<ChainUser[]> {
  const users = new Array(numUsers).fill(0).map((_, i) => {
    const uri = `${baseSeed}//${i}`;
    return { uri, keypair: keyring.createFromUri(uri) };
  });
  console.log(`Created keys for ${numUsers} accounts`);

  await resolveUsersFromChain(users);
  return users;
}

async function getCurrentBlockNumber(): Promise<number> {
  const block = await ExtrinsicHelper.apiPromise.rpc.chain.getBlock();
  return block.block.header.number.toNumber();
}

function getAddProviderPayload(user: ChainUser, provider: ChainUser, currentBlockNumber: number, schemaIds: AnyNumber[]): { payload: AddProviderPayload; proof: Sr25519Signature } {
  const mortalityWindowSize = ExtrinsicHelper.apiPromise.consts.msa.mortalityWindowSize.toNumber();
  const addProvider: AddProviderPayload = {
    authorizedMsaId: provider.msaId,
    schemaIds,
    expiration: currentBlockNumber + mortalityWindowSize,
  };
  const payload = ExtrinsicHelper.apiPromise.registry.createType('PalletMsaAddProvider', addProvider);
  const proof = signPayloadSr25519(user.keypair, payload);

  return { payload: addProvider, proof };
}

function getClaimHandlePayload(user: ChainUser, handle: string, currentBlockNumber: number) {
  const mortalityWindowSize = ExtrinsicHelper.apiPromise.consts.msa.mortalityWindowSize.toNumber();
  const handleBytes = new Bytes(ExtrinsicHelper.apiPromise.registry, handle);
  const payload = {
    baseHandle: handleBytes,
    expiration: currentBlockNumber + mortalityWindowSize,
  };
  const payloadToSign = ExtrinsicHelper.apiPromise.registry.createType('CommonPrimitivesHandlesClaimHandlePayload', payload).toU8a();
  const proof = { Sr25519: u8aToHex(user.keypair.sign(u8aWrapBytes(payloadToSign))) };

  return { payload, proof };
}

export async function provisionLocalUserCreationExtrinsics(
  provider: ChainUser,
  users: ChainUser[],
  options?: { schemaIds?: AnyNumber[]; allocateHandle?: boolean },
): Promise<void> {
  const { schemaIds, allocateHandle } = options || {};
  const currentBlock = await getCurrentBlockNumber();
  users
    .filter((u) => !u?.msaId)
    .forEach((u) => {
      const { payload: addProviderPayload, proof } = getAddProviderPayload(u, provider, currentBlock, schemaIds ?? DEFAULT_SCHEMAS);
      // eslint-disable-next-line no-param-reassign
      u.create = () => ExtrinsicHelper.apiPromise.tx.msa.createSponsoredAccountWithDelegation(u.keypair.publicKey, proof, addProviderPayload);

      if (allocateHandle) {
        const name = uniqueNamesGenerator({ dictionaries: [colors, names], separator: '', length: 2, style: 'capital' });
        const { payload: handlePayload, proof: handleProof } = getClaimHandlePayload(u, name, currentBlock);
        u.claimHandle = () => ExtrinsicHelper.apiPromise.tx.handles.claimHandle(u.keypair.publicKey, handleProof, handlePayload);
      }
    });
}

export function provisionUserGraphResets(users: ChainUser[], schemaIds?: AnyNumber[]) {
  return Promise.all(
    users.map(async (user) => {
      if (!user?.msaId) {
        return;
      }
      const { msaId } = user;

      await Promise.all(
        (schemaIds || DEFAULT_SCHEMAS).map(async (schemaId) => {
          const pages = await ExtrinsicHelper.apiPromise.rpc.statefulStorage.getPaginatedStorage(user.msaId, schemaId);
          if (!user?.graphUpdates) {
            // eslint-disable-next-line no-param-reassign
            user.graphUpdates = [];
          }

          user.graphUpdates.push(
            ...pages.toArray().map((page) => () => ExtrinsicHelper.apiPromise.tx.statefulStorage.deletePage(msaId, schemaId, page.page_id, page.content_hash)),
          );
        }),
      );
    }),
  );
}

export async function provisionUserGraphEncryptionKeys(users: ChainUser[], useWellKnownKey = true) {
  const currentBlockNumber = await getCurrentBlockNumber();
  return Promise.all(
    users.map(async (user) => {
      const currentPubKey = await getCurrentPublicGraphKey(user.msaId!);
      if (user?.graphKeyPair && currentPubKey === u8aToHex(user.graphKeyPair.publicKey)) {
        return;
      }

      if (!user?.graphKeyPair && useWellKnownKey) {
        user.graphKeyPair = {
          keyType: GraphKeyType.X25519,
          publicKey: hexToU8a(wellKnownGraphKeypair.publicKey),
          secretKey: hexToU8a(wellKnownGraphKeypair.privateKey),
        };

        if (currentPubKey === wellKnownGraphKeypair.publicKey) {
          return;
        }

        if (!user?.graphUpdates) {
          user.graphUpdates = [];
        }

        const { payload: addGraphKeyPayload, proof: addGraphKeyProof } = await getAddGraphKeyPayload(u8aToHex(user.graphKeyPair.publicKey), user.keypair, currentBlockNumber);

        user.graphUpdates.push(() => ExtrinsicHelper.apiPromise.tx.statefulStorage.applyItemActionsWithSignatureV2(user.keypair.publicKey, addGraphKeyProof, addGraphKeyPayload));
      }
    }),
  );
}
