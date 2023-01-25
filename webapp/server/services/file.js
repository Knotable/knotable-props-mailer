export default class FileService {
  constructor(store, validator, awsFileService) {
    this.store = store;
    this.validator = validator;
    this.awsFileService = awsFileService;
  }

  async createByS3Url(url) {
    const mime = await import("mime-types");
    const filePath = url.split("s3.amazonaws.com/").pop();
    let file = await this.awsFileService.getMetaData(filePath);
    if (!file) throw { code: 404, message: "File not found" };
    let fileNames = filePath.split("/");
    let fileName = fileNames[fileNames.length - 1];
    let fileExts = fileName.split(".");
    let ext = fileExts[fileExts.length - 1];

    return this.create({
      type: mime.types[ext] || "",
      name: fileName,
      size: file.ContentLength,
      s3_url: url,
    });
  }

  create(file) {
    this.validator(file, {
      name: String,
      type: String,
      s3_url: String,
      size: Number,
    });
    const existsFile = this.get({ s3_url: file.s3_url });
    if (existsFile) return existsFile._id;
    return this.store.insert({ ...file, createdDate: new Date() });
  }

  get(query) {
    this.validator(query, {
      _id: Match.Optional(String),
      s3_url: Match.Optional(String),
    });
    if (Object.keys(query).length == 0) throw new Error("Query is empty");
    return this.store.findOne(query);
  }

  remove(fileId) {
    this.validator(fileId, String);
    return this.store.remove(fileId);
  }
}
