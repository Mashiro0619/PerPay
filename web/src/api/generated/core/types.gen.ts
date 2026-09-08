
import type { Auth, AuthToken } from './auth.gen.js';
import type { BodySerializer, QuerySerializer, QuerySerializerOptions } from './bodySerializer.gen.js';
export type HttpMethod =
  | 'connect'
  | 'delete'
  | 'get'
  | 'head'
  | 'options'
  | 'patch'
  | 'post'
  | 'put'
  | 'trace';
export type Client<
  RequestFn = never,
  Config = unknown,
  MethodFn = never,
  BuildUrlFn = never,
  SseFn = never,
> = {
  buildUrl: BuildUrlFn;
  getConfig: () => Config;
  request: RequestFn;
  setConfig: (config: Config) => Config;
} & {
  [K in HttpMethod]: MethodFn;
} & ([SseFn] extends [never] ? { sse?: never } : { sse: { [K in HttpMethod]: SseFn } });
export interface Config {
  auth?: ((auth: Auth) => Promise<AuthToken> | AuthToken) | AuthToken;
  bodySerializer?: BodySerializer | null;
  headers?:
    | RequestInit['headers']
    | Record<
        string,
        string | number | boolean | (string | number | boolean)[] | null | undefined | unknown
      >;
  method?: Uppercase<HttpMethod>;
  querySerializer?: QuerySerializer | QuerySerializerOptions;
  requestValidator?: (data: unknown) => Promise<unknown>;
  responseTransformer?: (data: unknown) => Promise<unknown>;
  responseValidator?: (data: unknown) => Promise<unknown>;
}
export interface ClientMeta {}
type IsExactlyNeverOrNeverUndefined<T> = [T] extends [never]
  ? true
  : [T] extends [never | undefined]
    ? [undefined] extends [T]
      ? false
      : true
    : false;
export type OmitNever<T extends Record<string, unknown>> = {
  [K in keyof T as IsExactlyNeverOrNeverUndefined<T[K]> extends true ? never : K]: T[K];
};
