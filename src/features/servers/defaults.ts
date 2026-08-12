import type { ServerForm } from "../../domain/types";

export const initialServerForm: ServerForm = {
  name: "",
  host: "",
  port: "22",
  username: "root",
  note: "",
  authMethod: "password",
  password: "",
  sudoPassword: "",
  privateKeyPath: "",
  passphrase: "",
  rememberCredentials: true,
};
