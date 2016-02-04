@ApiAuthHelper =
  publicKey: do ->
    nodeRSA = Meteor.npmRequire 'node-rsa'
    return new nodeRSA '-----BEGIN PUBLIC KEY-----\nMIIBITANBgkqhkiG9w0BAQEFAAOCAQ4AMIIBCQKCAQBW0QDARmITcYXOkSzUrnS4\ngkL08DnI4DyDIAv+XnXJz9UUNgCrwps2FRI+B7t0Qx1Ls/ylJ7nVC3MV77sgX/CT\nYSDhtJs1VzoEjGbPqKez2CDYUpHqDMWOsCrO6D7nVG8nkFnrcjO+tX3h+bOZEOoG\nG8tHvWPO4C5XIxp06rH2QRzY6OpCJd6SEn77P4zOS2z/8OaNJW7N2Ws2NsZw8VVq\nH1NZn3gcNisaP8f9aZtziBuoTFHELbBz0GOf+B1ox3QNKCM4JP7LpC2jHykpnGpr\nPdBVu0gEl57mPzsWkm9pEZ+bDxcOURuhx/t/ZzfNI9iZOrVar47SVeN4Roowiyet\nAgMBAAE=\n-----END PUBLIC KEY-----'


  getAuthToken: ->
    return ApiAuthHelper.publicKey.encrypt(new Date().toString()).toString('hex')
