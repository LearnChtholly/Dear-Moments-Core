import type {Context} from '@deepseek-ai/cordis';
export interface DearMomentsMemory {
 search(query:string,signal?:AbortSignal):Promise<unknown[]>;
 source(id:string,signal?:AbortSignal):Promise<unknown>;
 observePlugin(pluginId:string,observation:{eventId:string;text:string},signal?:AbortSignal):Promise<{stored:boolean;scope:string}>;
 searchPlugin(pluginId:string,query:string,signal?:AbortSignal):Promise<unknown[]>;
}
declare module '@deepseek-ai/cordis'{interface Context{dearMomentsMemory:DearMomentsMemory;}}
export const name:string;
export const inject:string[];
export function apply(ctx:Context,config?:{autoCapture?:boolean;followCompanionPersona?:boolean;autoStart?:boolean;bridgeFile?:string}):void;
