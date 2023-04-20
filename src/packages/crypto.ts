import * as pulumi from '@pulumi/pulumi';
import * as tls from '@pulumi/tls';
import crypto from 'crypto';

interface EcDSAKeyPairArguments {
	curve: 'P224' | 'P256' | 'P384' | 'P521';
}

export class ECDsaKeyPair extends pulumi.ComponentResource {
	readonly key: tls.PrivateKey;
	readonly privateKeyDER: pulumi.Output<string>;
	readonly publicKeyDER: pulumi.Output<string>;

	constructor(name: string, args: EcDSAKeyPairArguments, opts?: pulumi.ComponentResourceOptions) {
		super('Keeta:Crypto:ECDsaP256KeyPair', name, args, opts);

		this.key = new tls.PrivateKey(`${name}-cssm-keypair`, {
			algorithm: 'ECDSA',
			ecdsaCurve: args.curve
		}, { parent: this });

		this.privateKeyDER = this.key.privateKeyPem.apply(privateKeyPem => {
			const privateKey = crypto.createPrivateKey(privateKeyPem);
			return privateKey.export({ format: 'der', type: 'sec1' }).toString('base64');
		});

		this.publicKeyDER = this.key.publicKeyPem.apply(publicKeyPem => {
			const publicKey = crypto.createPublicKey(publicKeyPem);
			return publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
		});
	}
}
