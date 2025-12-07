import * as pulumi from '@pulumi/pulumi';
import * as tls from '@pulumi/tls';
import crypto from 'crypto';

interface ECDSAKeyPairArguments {
	curve: 'P224' | 'P256' | 'P384' | 'P521';
}

export class ECDSAKeyPair extends pulumi.ComponentResource {
	readonly key: tls.PrivateKey;
	readonly privateKeyDER: pulumi.Output<string>;
	readonly publicKeyDER: pulumi.Output<string>;

	constructor(name: string, args: ECDSAKeyPairArguments, opts?: pulumi.ComponentResourceOptions) {
		super('Keeta:Crypto:ECDSAKeyPair', name, args, opts);

		this.key = new tls.PrivateKey(`${name}-keypair`, {
			algorithm: 'ECDSA',
			ecdsaCurve: args.curve
		}, { parent: this });

		const privateDER = this.key.privateKeyPem.apply(function(privateKeyPem) {
			const privateKey = crypto.createPrivateKey(privateKeyPem);
			return(privateKey.export({ format: 'der', type: 'sec1' }).toString('base64'));
		});

		const publicDER = this.key.publicKeyPem.apply(function(publicKeyPem) {
			const publicKey = crypto.createPublicKey(publicKeyPem);
			return(publicKey.export({ format: 'der', type: 'spki' }).toString('base64'));
		});

		this.privateKeyDER = pulumi.secret(privateDER);
		this.publicKeyDER = pulumi.secret(publicDER);
	}
}
