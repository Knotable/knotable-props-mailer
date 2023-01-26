import AwsFileService from "./aws-file";
import FileService from "./file";

export default class FilesService {
  constructor(store, validator, fileService) {
    this.fileService = fileService;
    this.store = store;
    this.validator = validator;
  }

  async createFromS3Urls(urls, extra) {
    const uniqUrls = new Set(urls);
    const result = await Promise.allSettled(
      Array.from(uniqUrls).map((url) =>
        this.fileService.createByS3Url(url, extra)
      )
    );
    return result
      .filter((res) => res.value !== undefined)
      .map(({ value }) => value);
  }

  get(query = {}, { limit = 0, sort = { createdDate: 1 }, skip = 0 } = {}) {
    this.validator(query, {
      creatorId: Match.Optional(String),
    });
    return this.store.find(query, { limit, skip, sort }).fetch();
  }

  delete(query) {
    this.validator(query, {
      creatorId: Match.Optional(String),
      filesIds: [String],
    });

    return this.store.remove({
      _id: { $in: query.filesIds },
      creatorId: query.creatorId ? query.creatorId : { $exists: false },
    });
  }

  static createDefault() {
    const fileService = new FileService(
      Files,
      check,
      AwsFileService.createBySettings()
    );

    return new FilesService(Files, check, fileService);
  }
}
