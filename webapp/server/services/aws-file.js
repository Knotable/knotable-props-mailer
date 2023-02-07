import { S3Client, HeadObjectCommand } from "@aws-sdk/client-s3";

export default class AwsFileService {
  constructor({ region, bucket, accessKeyId, secretAccessKey }) {
    this.region = region;
    this.bucket = bucket;
    this.accessKeyId = accessKeyId;
    this.secretAccessKey = secretAccessKey;
  }

  getMetaData(path) {
    const credentials = {
      accessKeyId: this.accessKeyId,
      secretAccessKey: this.secretAccessKey,
    };
    const client = new S3Client({ credentials, region: this.region });
    const command = new HeadObjectCommand({
      Key: path,
      Bucket: this.bucket,
    });
    try {
      return Promise.await(client.send(command));
    } catch (err) {
      throw err;
    } finally {
      client.destroy();
    }
  }

  static createBySettings() {
    const settings = Meteor.settings.AWS;
    return new AwsFileService(settings);
  }
}
