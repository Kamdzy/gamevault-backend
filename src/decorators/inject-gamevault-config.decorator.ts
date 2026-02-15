import { Inject } from "@nestjs/common";

import { GAMEVAULT_CONFIG } from "../gamevault-config";

export const InjectGamevaultConfig = () => Inject(GAMEVAULT_CONFIG);
