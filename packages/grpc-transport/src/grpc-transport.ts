import {
    ClientStreamingCall,
    Deferred,
    DeferredState,
    DuplexStreamingCall,
    mergeRpcOptions,
    MethodInfo,
    RpcError,
    RpcInputStream,
    RpcMetadata,
    RpcOptions,
    RpcOutputStreamController,
    RpcStatus,
    RpcTransport,
    ServerStreamingCall,
    UnaryCall
} from "@protobuf-ts/runtime-rpc";
import {GrpcOptions} from "./grpc-options";
import {Client, ClientWritableStream, Metadata, ServiceError, status as GrpcStatus} from "@grpc/grpc-js";
import {assert} from "@protobuf-ts/runtime";


/**
 * Is the given argument a ServiceError as provided
 * by @grpc/grpc-js?
 *
 * A ServiceError is a specialized Error object, extended
 * with the properties "code", "details" and "metadata".
 */
function isServiceError(arg: any): arg is ServiceError {
    if (typeof arg != 'object' || !arg) {
        return false;
    }
    const rp = ['code', 'details', 'metadata', 'name', 'message'];
    if (!rp.every(p => arg.hasOwnProperty(p))) {
        return false;
    }
    return typeof arg.code == 'number'
        && typeof arg.details == 'string'
        && typeof arg.metadata == 'object'
        && typeof arg.name == 'string'
        && typeof arg.message == 'string';
}


function rpcMetaToGrpc(from: RpcMetadata, base?: Metadata): Metadata {
    const to = base ?? new Metadata();
    for (let k of Object.keys(from)) {
        let v = from[k];
        if (typeof v == 'string') {
            to.add(k, v);
        } else {
            for (let vv of v) {
                to.add(k, vv);
            }
        }
    }
    return to;
}


function grpcMetaToRpc(from: Metadata): RpcMetadata {
    const meta: RpcMetadata = {};
    const h2 = from.toHttp2Headers();
    for (let k of Object.keys(h2)) {
        let v = h2[k];
        if (v === undefined) {
            continue;
        }
        if (typeof v === "number") {
            v = v.toString();
        }
        meta[k] = v;
    }
    return meta;
}


export class GrpcTransport implements RpcTransport {


    private readonly defaultOptions: GrpcOptions;

    constructor(defaultOptions: GrpcOptions) {
        this.defaultOptions = defaultOptions;
    }

    mergeOptions(options?: Partial<RpcOptions>): RpcOptions {
        return mergeRpcOptions(this.defaultOptions, options);
    }

    unary<I extends object, O extends object>(method: MethodInfo<I, O>, input: I, options: RpcOptions): UnaryCall<I, O> {

        const opt = options as GrpcOptions,
            meta = opt.meta ?? {},
            gMeta = rpcMetaToGrpc(meta, new Metadata({
                idempotentRequest: method.idempotency === "IDEMPOTENT"
            })),
            client = new Client(opt.host, opt.channelCredentials, opt.clientOptions),
            defHeader = new Deferred<RpcMetadata>(),
            defMessage = new Deferred<O>(),
            defStatus = new Deferred<RpcStatus>(),
            defTrailer = new Deferred<RpcMetadata>(),
            call = new UnaryCall<I, O>(method, meta, input, defHeader.promise, defMessage.promise, defStatus.promise, defTrailer.promise)
        ;

        const gCall = client.makeUnaryRequest<I, O>(
            `/${method.service.typeName}/${method.name}`,
            (value: I): Buffer => Buffer.from(method.I.toBinary(value, opt.binaryOptions)),
            (value: Buffer): O => method.O.fromBinary(value, opt.binaryOptions),
            input,
            gMeta,
            // callOpts,
            (err, value) => {
                if (value) {
                    defMessage.resolve(value);
                }
                if (err) {
                    const e = new RpcError(err.message, GrpcStatus[err.code], grpcMetaToRpc(err.metadata));
                    defHeader.rejectPending(e);
                    defMessage.rejectPending(e);
                    defStatus.rejectPending(e);
                    defTrailer.rejectPending(e);
                }
            }
        );

        if (opt.abort) {
            opt.abort.addEventListener('abort', ev => {
                gCall.cancel();
            });
        }

        gCall.addListener('metadata', val => {
            defHeader.resolve(grpcMetaToRpc(val));
        });

        gCall.addListener('status', val => {

            // if we get a status (via trailer), but did not get a message,
            // we require that the status is an error status.
            if (defMessage.state === DeferredState.PENDING && val.code === GrpcStatus.OK) {
                const e = new RpcError('expected error status', GrpcStatus[GrpcStatus.DATA_LOSS]);
                defMessage.rejectPending(e);
                defStatus.rejectPending(e);
                defTrailer.rejectPending(e);
            } else {
                defStatus.resolvePending({
                    code: GrpcStatus[val.code],
                    detail: val.details
                });
                defTrailer.resolvePending(grpcMetaToRpc(val.metadata));
            }
        });

        return call;
    }


    serverStreaming<I extends object, O extends object>(method: MethodInfo<I, O>, input: I, options: RpcOptions): ServerStreamingCall<I, O> {

        const opt = options as GrpcOptions,
            meta = opt.meta ?? {},
            gMeta = rpcMetaToGrpc(meta, new Metadata({
                idempotentRequest: method.idempotency === "IDEMPOTENT"
            })),
            client = new Client(opt.host, opt.channelCredentials, opt.clientOptions),
            defHeader = new Deferred<RpcMetadata>(),
            outStream = new RpcOutputStreamController<O>(),
            defStatus = new Deferred<RpcStatus>(),
            defTrailer = new Deferred<RpcMetadata>(),
            call = new ServerStreamingCall<I, O>(method, meta, input, defHeader.promise, outStream, defStatus.promise, defTrailer.promise)
        ;

        const gCall = client.makeServerStreamRequest<I, O>(
            `/${method.service.typeName}/${method.name}`,
            (value: I): Buffer => Buffer.from(method.I.toBinary(value, opt.binaryOptions)),
            (value: Buffer): O => method.O.fromBinary(value, opt.binaryOptions),
            input,
            gMeta,
            // callOpts
        );

        if (opt.abort) {
            opt.abort.addEventListener('abort', ev => {
                gCall.cancel();
            });
        }

        gCall.addListener('error', err => {
            const e = isServiceError(err) ? new RpcError(err.message, GrpcStatus[err.code], grpcMetaToRpc(err.metadata)) : new RpcError(err.message);
            defHeader.rejectPending(e);
            if (!outStream.closed) {
                outStream.notifyError(e);
            }
            defStatus.rejectPending(e);
            defTrailer.rejectPending(e);
        });

        gCall.addListener('end', () => {
            if (!outStream.closed) {
                outStream.notifyComplete();
            }
        });

        gCall.addListener('data', arg1 => {
            assert(method.O.is(arg1));
            outStream.notifyMessage(arg1);
        });

        gCall.addListener('metadata', val => {
            defHeader.resolve(grpcMetaToRpc(val));
        });

        gCall.addListener('status', val => {
            defStatus.resolvePending({
                code: GrpcStatus[val.code],
                detail: val.details
            });
            defTrailer.resolvePending(grpcMetaToRpc(val.metadata));
        });

        return call;
    }


    clientStreaming<I extends object, O extends object>(method: MethodInfo<I, O>, options: RpcOptions): ClientStreamingCall<I, O> {

        const opt = options as GrpcOptions,
            meta = opt.meta ?? {},
            gMeta = rpcMetaToGrpc(meta, new Metadata({
                idempotentRequest: method.idempotency === "IDEMPOTENT"
            })),
            client = new Client(opt.host, opt.channelCredentials, opt.clientOptions),
            defHeader = new Deferred<RpcMetadata>(),
            defMessage = new Deferred<O>(),
            defStatus = new Deferred<RpcStatus>(),
            defTrailer = new Deferred<RpcMetadata>(),
            gCall = client.makeClientStreamRequest<I, O>(
                `/${method.service.typeName}/${method.name}`,
                (value: I): Buffer => Buffer.from(method.I.toBinary(value, opt.binaryOptions)),
                (value: Buffer): O => method.O.fromBinary(value, opt.binaryOptions),
                gMeta,
                // callOpts,
                (err, value) => {
                    if (value) {
                        defMessage.resolve(value);
                    }
                    if (err) {
                        const e = new RpcError(err.message, GrpcStatus[err.code], grpcMetaToRpc(err.metadata));
                        defHeader.rejectPending(e);
                        defMessage.rejectPending(e);
                        defStatus.rejectPending(e);
                        defTrailer.rejectPending(e);
                    }
                }
            ),
            inStream = new GrpcInputStreamWrapper(gCall),
            call = new ClientStreamingCall<I, O>(method, meta, inStream, defHeader.promise, defMessage.promise, defStatus.promise, defTrailer.promise)
        ;

        if (opt.abort) {
            opt.abort.addEventListener('abort', ev => {
                gCall.cancel();
            });
        }

        gCall.addListener('metadata', val => {
            defHeader.resolve(grpcMetaToRpc(val));
        });

        gCall.addListener('status', val => {
            defStatus.resolvePending({
                code: GrpcStatus[val.code],
                detail: val.details
            });
            defTrailer.resolvePending(grpcMetaToRpc(val.metadata));
        });

        return call;
    }


    duplex<I extends object, O extends object>(method: MethodInfo<I, O>, options: RpcOptions): DuplexStreamingCall<I, O> {
        throw new Error("NOT IMPLEMENTED");
    }

}


class GrpcInputStreamWrapper<T> implements RpcInputStream<T> {

    constructor(private readonly inner: ClientWritableStream<T>) {

    }

    send(message: T): Promise<void> {
        return new Promise<void>((resolve, reject) => {
            this.inner.write(message, resolve);
            // this.inner.end(message, resolve);
        });
    }

    complete(): Promise<void> {
        this.inner.end();
        return Promise.resolve(undefined);
    }


}
