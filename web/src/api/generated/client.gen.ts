
import { type Client, type ClientOptions, type Config, createClient, createConfig } from './client/index.js';
import type { ClientOptions as ClientOptions2 } from './types.gen.js';
export type CreateClientConfig<T extends ClientOptions = ClientOptions2> = (override?: Config<ClientOptions & T>) => Config<Required<ClientOptions> & T>;
export const client: Client = createClient(createConfig<ClientOptions2>({ baseUrl: '/' }));
