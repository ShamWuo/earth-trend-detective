import type { ETGDatasetId } from "@/types/etg";

export type EarthSurfaceRegime =
  | "inland_land"
  | "inland_lake"
  | "coastal_marine"
  | "open_ocean";

export interface EarthSurfaceClassification {
  regime: EarthSurfaceRegime;
  hasMarineSurface: boolean;
  hasTerrestrialSurface: boolean;
  isInlandLake: boolean;
  lat: number;
  lng: number;
}

export interface DatasetSurfaceValidation {
  applicable: boolean;
  regime: EarthSurfaceRegime;
  reason?: string;
}

const MASK_WIDTH = 720;
const MASK_HEIGHT = 360;
const TOTAL_CELLS = MASK_WIDTH * MASK_HEIGHT;

const REGIME_BY_CODE: readonly EarthSurfaceRegime[] = [
  "inland_land",
  "inland_lake",
  "coastal_marine",
  "open_ocean",
];

// 0.5° × 0.5° global 4-class RLE mask derived from public/textures/earth/earth-water.png
// 0 = inland_land, 1 = inland_lake, 2 = coastal_marine, 3 = open_ocean
const SURFACE_MASK_RLE_BASE64 =
  "////////////////////////////////////////////////////////////////////////////////////////////////////" +
  "////////////////////////////////////////////////////////////////////////////////////MzLHrv//////////" +
  "/2eig8b///////////8v0ht2ATYcSv///////////wdiXL4cCiRiAw4LGv//Nwr///////9vYhAKUL5Qrv//DyIHCgsSvw4TEv//" +
  "////M1oEOjRWHCoQElQmEHL/wzITWr8OAyr//////yueKFL8KF7jRiMWWzIHZr8+//////8LEgcSEHoQVvxQNr8WA2obFlsyB2bD" +
  "JgQi/////8cWExIHJhBGEEYHJvxQJs+GGxZnJgcKBx4HCuMmBDr/////fxYXbhg6FHL8UB7XirMO/zN+/////18mE74cIgNG/Ewm" +
  "1zoAQv//F2b/////TzYPwhQmByb8aCrXdv//L1r/////K1oPuhgmCzr8VCrfbv//CkM6/////xtuCxoDmhgaGzb8VCrvLgsi/0Me" +
  "mwonChti////33oH6ida/DAi9yYbDv8fSpsKGxYDLghGvw7///8H/m4nbvwcIv8DFv8/WqtWFEqjTv//374ANgBiQ2L8GCL//09i" +
  "l1pgEqN2///H/lKTHvwQHv//R1KbQggKcBajgv//m64Prp8W/Agm//8/Pq8uaAUgJqOC//+bphOypxLwCgQi//87PqsmYAkkATID" +
  "Ei8SWzoTIv//m24PJg/OkxboNv//NzZLFjs+iGofMk8m///PEhh6B9qXDuQu//87FgAWUx4DEhNKiMJTHv//xxYUggcaBFYAGgw6" +
  "iwoB5CL//z82T0IDLrAmEAoYLggiQ17//5cWECYEQgASAx4AOgMOCBYQQoMKABbMHv//QxYEDlOGpApkHhABABIPCiNi6xabDudW" +
  "HAoEEgQOB1ILMhAaDCpzJsQm//8/FgQOSxYMZvxUFgdOEELPIoNGz04ECiAOBBITQgsySC5jLrwSAA7/Zy6nNj8aDDoIHvxYYhwS" +
  "CF6LJntukxITGgs6MBoLEgMOCBIDMiAKHAoAJlsqrAEALv9PUqM+LxIUOhAW/GAyCA5YToseczIAgid2BzowJgciBBYDaiAqVyq0" +
  "Lv8zfptWDw4cFhAKFBL8aBKUHhA2D2p7IiSGB8YcEggaA8IoFlcusC7/H0YAXlsWNz4DEhQmLAoUAfz8OLJXJnyOAHYQtgNqHBJX" +
  "LrAq/xs+NEpHGgsOE2YMMvz8hLpPIrQiAA4sGgzeDB4DDggSBwoDJhgWVyqACgQy/ycmdDIfGgNuEC4MNvz8xBowOjsazBKExgwy" +
  "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" +
  "DkwOHyYAFgMaMA4XHiMOKCHABfyULh82///HDvwYBRgNOB7/3wpIEh8OBy4HEjASCzIXDiwdAAX8/FQSOyb//9cOTAX8KCb/3wo8" +
  "HhsWBzYDChSWMCn8/AwOMApHFv//4w5QAfwoGv/rCjgaIxYLQghSFDY0GQAF/PwEGiQSRxb//+MO/HwW//MKOA4DFhMWFzoEPjga" +
  "QBX8/BAyCBpHFv//4w78bBr/+w40DgcWFxIfMgQ6nB38/EIEEk8W///nCvxsGv/7CjgKAx4XEiMWCw4AKqwd/PgWAyoEDk8a///n" +
  "DvxoGv/7DjQKAxYfEg8qCz54ASgl/PQWAxILCgQSSxr//+cW/GAS//8DDjAOAworChMuDz6kJfz0Kg8SAA5HHv//6xL8YBL//wMa" +
  "HBY/EgcmFz6EARgl/PQyBxYADjMaAA7///MO/FwS//8HHgQiE2ojJgcWAA4MFkABHB38/AAmCxIADjMWAA7///cO/FwO//8LQgNi" +
  "AxonFhNSbA38dAWIJg8OBAorHgAO///7DvxYDv//H5YPDicSG078/IweEw4IChsiABL///8S/FQO//8fSjgOV2r8/JASIwoEDgsm" +
  "CBb///8DDvxUDv//HzpIDlceJxIDCvz8jBIjJgdO////Bxb8PBb//x82TBJXHicSAwr8/IwSIyIDUv///w8a/Cwa//8fEnQSXwoz" +
  "EgMK/PyMFh9y////Fx78KBb//xsWeBKzDvz8kBIfDgdG////NxYAAfwUGv/bCjMWfCYvFlcK/PyQAQQKHw4DRv///0cK/BQW/+cK" +
  "LxKMKhsiUwo4Afz8XA4bDgMu////Xw78EBL/6wovDpgmFzo3Dvz8oA4rKv///2cm8BL//ycOsB4LCgguBy78/KQONxb///9vJvAK" +
  "//8vCrweAwoUWvz8oAEACjcS////dyakKhgK//8vCsAqKEJoCvxAAeQSNw7///9/IoxWBAr//y8K0Bo4CgwKcBb8/CQW////wyKA" +
  "ZgAK//8PCg8O1BJYCgAKXB78/CAW////xyZsQhMu/+sKEwoLEvxEGlwi/PwkDv///8cqaBYPGiMOAAr/6xYHCgcS/EgaXA4DDvz8" +
  "IA4vCv///5MqXBpXGv/rQvxMHlgOBxL8/BQSLwr///+TLlgOYx7/7zL8WB5YDgMaDAr88A4zCv///5M2UApnDgAW/+si/GQeWA4D" +
  "NvzkEv///9c2UAprJgMK/+cS/GgeWBIHLvzkEv///+MqUApvIgMK/+cO/HAKAw5cFgMq/OAO////6ypMCm8WDwr/4w78dA4DDlgW" +
  "EzIIIvyUDv////MqSApzEgMO/+sO/HgeWBYLbvyMIv///+MyPA5zEgMO/+cO/HwiWBIHHgdK/Igm////4zY4Co8O/+MS/IAiVCoA" +
  "Ej8S/Hwq////6xYHEjQKkwr/4w78iAoDElgeBBo3FvxwFgMW////7xILEjAKYyoDCv/fDvyMDgMOXAoYGjcemAqsIgcS//9rDv97" +
  "Dg8OMApfOv/fDvyQEgMOjBI7FgAOgBKcJg8S//9rDv9/ChMKMApfQv/XDvyQEgcKkA4/EgAOaCp4CgwuDxL//2sa/5MOLA4vIgdG" +
  "/9MO/JgOAwqQDj8OBA5kMmw+Jwr//38W/4sKMAorJgcWBy4HCv+3CvygCgMKjBJDImQiAwpkOv//vx7/gwowDicmNzL/tw78nAoD" +
  "DoQSRyJgDhsOYBIHDv//2xL/gwowDicKCA43Sv+fDvycCgcSeBJPHlQWHxZUEgMW///fDv+DDjAOHw4ICkNG/58K/JwKBxZ0DmcK" +
  "VBYjElASAxr//98O/4MWLA4XDggKRwoTLv+XCvycDgsObBJrClASMw5MCgsa///fDv+HGiQ2CAo/GgNO/38O/JwOCwpsEm8GTBI3" +
  "DkwOBxpDFv////8jGiAuDAo/GgNO/4MK/JwSBxJcGm8KRBI/CkwOBxZHFv////8jIiAaFA4/GgNO/4MK/KAOCw5YFncKPBZDClAO" +
  "AxZHFv////83FkwKSwojCv+rDvykDgsOSBp/CjwOTwYICjwOXwYACv////83IkAKywr/Wwr8rAoLDjwigwowFk8KABY4ElMOAAr/" +
  "////QzoYLqsK/ycKJwr8rAoLDjwWkwooFlMmPBJPHv////9LOhA2owr/HxIjDvysEgcKNBabCiQaUyZEDkse/////1MyEDajDv8X" +
  "Fh8S/LASAwooHp8OIBJbFgMKSA5HGv////9/EjAOow7/Fw4nDvy0IiQepwogCoMKRA5LHv////97GigKpwr/FworDvy8HhQesw4c" +
  "CoMKSApLKv////9zLhAK//8HDvy8GgQmvwocClsKGyIwCk8m/////3cqEAr//wcO/MQ2ywocClcOGyYsCk8m/////4saDApPDv+n" +
  "DvzIIjMOlw4YClcOHyYoCk8u/////48aAApLHv+fDvzIFiMOBw6bChQOVwojKiQKSzL/////kyI/Ov+TDvycASQODyoHDpsOEA5X" +
  "CiMSBxIcDks2/////5MeN0IbHv9bEvzADgM2twoQClsKIxIPDhQSQxIDJv////+XHjN+/1sW/LxKtw4IDosSDxYAHkMOByb/////" +
  "lyIvCgwCAQYIRv9jEvy8IhQKuwoIEocOFypLEgci/////5smAy4UBSAy/2cS/MAKIA67CgQagxIbHkcWDyb/////k1oUBTwW/2sO" +
  "/PAKvzJ/Eh8WRxYTJv////+fTmgW/2MK/OwOvzJ/FhsSSxYTJv////+nPnAa/18O/OQOxxYDFnsWGwpTDhcq/////6seAxZ4Ev9f" +
  "EvzgDssSAxZ7FqMaAAr/////sxYDDogS/1sW/NQO5wYAClMKHx5rDhsq/////7MWBw6IEv9bGkwm/FQO5xZTCiMeYxYXCgMa////" +
  "/9cKiC7/RxZAMvxQCusWUwojIl8eBxIDGv/////XCpAu/0MSHA4IIgMS/EwO6xJjEg8OABJXJgMKCxb/////2wqUMv9DXhcO/EQO" +
  "/2ciBwoADk8uAwoTDv/////bCrAa/0NSHyb8KBL/ZyIHCgQKSxIIEi8K/////9MKvA7/RyIPDi8q/CAO/28iAwoEChsKHxYEEjMK" +
  "/////9MKwAr/vw4DEvwcDv93MgAKGwobEgwONwr/////0wrECv/PEvwYDv97MgAKGwoPGhAK//////8PFsQK/88S/BAW/3tGLxoU" +
  "DkMO/////7cSyBL/zwr8DBb/f0ofHhwOKwoHEv////+3CtAS/88KoAFcGv+DHgAmGxooDgcKDw4HEv////+vEtQO/88KnAFcEv+X" +
  "FggiFxokRgcS/////1MKTxLQEv+3CgsK/BL/mxoMGhcKNEYHEv////9TCksS0CL/qwoHDvgS/6MaDBYXCjRCBxIDEv////8/GjsK" +
  "2C7/nwoDDpgBDBUwEv+vFgwKHwo0CgMuCxIDNv////8bGjcO2Db/pw6sDTgO/7MaCA4bDiwKAy4PEgM6/////xcaNwrsLv+fDqwN" +
  "NA7/txoIGhMOJA4DNgsOB0b/////WwrsEgQe/5cKrAk0Dv+7GgwaDw4kCgc2Cw4DKgMqKwr/////ExK8ASAODDL/fxKkCSwW/7se" +
  "DCYDCiQKBzYLeh8KCw7////3EuQKGDL/exLcEv/LFgwiAyYEDgciB24AJhcKCxr////rEvwMOv93DtwK/9MaDB4DOgsiE1oYHice" +
  "////4xb8NBb/dw7UDv/fEggKAw4TKgsmDy4DIiQiJxL////jEvw8Fv93DoABRA7/5xIECjsWDyYLLgMqKBojEv///+MK/Ewe/2cS" +
  "fAFEDv/rEgAKOwobJj8yKBIfFv///+MO/Ewa/2sOgAFADv/vHmMmTwoDFixCBwr////PDvxUEv9vCoABPBL/9yZTDgcOSw4LDjA6" +
  "Cwr////TDvxYDv9rDnwBPBL/90oLChcOBwpPDg8OLDITGv///8MS/FgK/28KfAU4Ev//A1Z3CgcOEwo0Jhca////xxL8VAr/bw58" +
  "ATwK//8HVkcSFw4HDg8OHBIADi8m////wwr8VAr/cwqAATgK//8PTgcOGyYXDiMaEC43Iv///7sO/FAK/3MKgAE4Cv//F6YTDiMi" +
  "CC43Lv///7MK/EwO/3MKeAFECv//J5JHOgcqBwoXKv///7MO/EQO/3cKcAFMCv//Q3ZfIgcuAwobKv///7MK/BgFIA7/dwqcASAO" +
  "//9rFgsabxYXNisa////sw78EAEgEv97DpgBIA7//2sWBxarJjceEwr///+TCvw4Dv+DCsQK//9zDgcSIx4/Dh8iRw4TCv///5MO" +
  "/DAS/4MKnAEkBgsK//9zCismNw4vDksOEwr///+XCvwsDv+LCpwBJAYLCiMK//97PhsW/////1MK/CQO/4sOmAUkBgsKIw7//3c+" +
  "Gxb/////Uw78HBL/hxKcASQGOw7//3caBBobGv9TDv//6w78HA7/iw6gASQGMxr//1sKCw4cDhsKAAr/Uw7//+8K/BwK/48KpAEk" +
  "Cise//9TFgMOHBIbCgAS/0sO///vDvwYCv+PCqgBIAorDgAK//9LLiASGwoAEqMK////mxL8FAr/iwrUCicOBAr//0suIBIbCgAW" +
  "nw7///+bFvwMCv+HDtAOGxoADv//RxIEFiASGwoIDp8OXwL///87GhAF6Ar/hw7QDhMeBA7//z8WFAogGhMKDAqfElMO////Ox4Q" +
  "AeQK/4cKzBIXFgwO//83FlQeAw4QCpsSSxb///9DGvgK/4cKfAFAGhMOGAr//zcaXBYDChQOmw5LFucK//9XFvQG/4sKvB4XChwK" +
  "//83FmQiFA6nCjsW7wr//18W5A7/iwq4Gh8KGAr//zsWbBoYCqcKOxLzCv//YxLkDv+LDrAWJwoYCv//Nw58EhwKpw43Ev///2sK" +
  "5Ar/kw6oEi8KGAr//zcOsA6nCjcO////bwrkCv+TDqQSMwoYCv//Mw60Fp8K////uwbgDv+XDpwSOwYUDjcK/9civBpvChsK////" +
  "uwbgDv+bCpwOOwoUCjsK/8suxBJvEhMK////uwbcDv+fDpgONw4UCisKAwr/wyrYDmsi////ywbcCv+jDpwKNw4QDisK/88e6A5r" +
  "Kv///8MG2A7/pw6YDi8OFAovCv/HGvgSZyb////DBtQS/6sOlA4vChQO//8W/AQSax7///+/Crwq/6sOmAovDhAO//8O/AwSbw7/" +
  "///LCrQm/7sKmAozChAK//8DCvwYDv////9HCqwa/88KmAozChAK//8DCvwYEv////9DCqga/9MKkBIzCgwO//8DCvwcFv////87" +
  "CqQW/9sKhB4zJv//Bwr8IBb/////NwqgEv/jCoAeOyL//wcO/CAS/////zcKoA7/6wp8Eksa//8HEvwkDv////8zCqQK/+8KfAr/" +
  "/3cS/CgK/////zMKpAb/8wp8Cv//dxL8KAr/////MwqkBv/zDngK//97DvwoCv////8zCqAK//cKeAr//38K/CgK/////y8OoAr/" +
  "9xJsDv//fw78KAr/////KwqgDv/3EmgO//+HCvwoCv////8rCpwS//sSYBL//4cK/CQO/////ysKkBb//wcOXBL//4sK/CQK////" +
  "/ysOkBb//wsKXA7//5MK/CAK/////ysOjBb//w8OVA7//5cK/CAK/////ysKkBb//xMOTBL//5cOWCaUCv////8zBoga//8XDkgS" +
  "//+fCkRGiAr/////MwqAGv//HwpAEv//pwo8KgceDApkDv////8vDoAW//8jCjwW//+nCjQmHxYICmAS/////y8OgBL//ycKMB7/" +
  "/6cOHC43DgQOXBL/////MwpcDhAS//8rEgA+//+vDhAuQypYDv////83Clwy//8vUv//sxIEMksqUA6jCv///4cKYC7//zsiBwr/" +
  "/8cubyZQCqcS////fwpgKv//Qw7///MeeyZMCqcW////dw5oDv//////ZwqLIkQOpxb///93CmwO////////IkQKqx7///9rDmwO" +
  "////////FwpECrMW////aw5sDv///////xcOPA63Jv///1cKbBL///////8XHgQOBBq7Jv///1cKSAoEHv///////x9Wuyb///9X" +
  "Ckgu////////J0LDEgQS////VwpIJv///////0MOAxLLEgQO////Vw5ICv///////2MKFwq/FgAO////Vw40CgQK////////YxYL" +
  "CrMy////Wwo4Hv///////2Musy7///9fEjAe////////ayavLv///2MSMBb///////9zJqsu////YxYwEv///////3sKBA6nEgAW" +
  "////ZxYwEv///////3sioyb///9zFiwW////////fx6bFgAORwr///8jFiwO////////ixqTMkcK////IxYsCv///////5MKlzpH" +
  "Cv///yMSJBb/////////MxYIDv///4MSIBr/////////MxIIDv///4MWHBL/////////PxIEDv///4MOKA7/////////Qyr///+D" +
  "EiQa/////////zcm////hxIoFv////////8/Gv///4sSMA7/////////Pw7///+XDiwW/////ysK////////rwowEv////8vEv//" +
  "/////6cOKBL/////MxL///////+nDiAS/////zsS////////pw4cFv////87Ev//8wr///+nDhwS/////////0cK////pxIYDjce" +
  "////////8wr///+rDhgOMyL/////////////qxIIHi8i/////////////6sWAQAeLxb/////Gwr///////+TFgEi/////18K////" +
  "////k0bfEv///2MK////////l07TEv////////////8TQtMS/////////////xc+2wr/////////////Hyb//////////////ycW" +
  "////////////////////////////////////////////////////////////////////////////////////////////////////" +
  "//////////////////////////////////+TCv//////////////Mwr//////////////xcSBwr//////////////wse////////" +
  "//////8fLv//////////////Dy7/////////////90b/////////////80L/////////////+z7/////uxYjCv//////9zIDCv//" +
  "//9PCl9KOw7//////58aBBL///9nNr8WByInXhsmPxoXOv/////TJgwO////Z0K3egRaAzYfNg9e/////6cmGAr///9LMhQum3o0" +
  "Pgz6/////4siGA7///87OiByTxYEChA2WCIQTgwiNE7/////dxogDv///ytKJG4HEh8q8DosElwqKwr/////PxogCv//4xIjOgAO" +
  "YAoAVhMm/ORe/////x8uJAr/zxLvJh8ezDIHGvz8CGb////jTiQK/8siNxIHMkNy3BIALvz8REb////TJgQaKAr/w/5e/Awe/Pxk" +
  "Pv///78iDA4wCv+LTgByAHYgLvwQCvz8kEr///+bFlgK/39SIB5wKvz8/PwkSv//xy6bFlwK/282/Pz8/Pw4Uv//o0Z7Cg8eVAr/" +
  "Vy78/Pz8/Iwe//+jhjs+UAr/Pz78/Pz8/JwW//+TCgMSJF4bSlAK/zcq/Pz8/PysHv/rKn8KAx4kCgBWAxYBAC5QCv8zIvz8/Pz8" +
  "rCb/v74bCgMebDocDlQO/x8m/Pz8/Py0Lv+fVgCCLxpwKogS/xsm/Pz8/Py0IgcK/4dqVEIDMvwsFv8PKvz8/Pz8tBb/d16wXvws" +
  "Ju8i/Pz8/PzEFv9nZsBW/Dg2yy78/Pz8/MgS/2NW/PyAOqMq/Pz8/PzcCv8vYvz8wEJzPvz8/Pz84BILDv8LRvz89D4nGg8y/Pz8" +
  "/Pz4FgNam2b8/PwUnvz8/Pz8/AyCB7L8/Pxkcvz8/Pz8/CgeCAoQ2vz8/IwiFBb8/Pz8/Pw0ClgWDG78/Pz8/Pz8/Pz8/Pz8/Pz8" +
  "/Pz8/Pz8/Pz8/Pz8/Pz8/Pz8/Pz8/Pz8/Pz8/Pz8/Pz8/Pz8/Pz8/Pz8/Pz8/Pz8/Pz8/Pz8/Pz8/Pz8/Pz8/Pz8/Pz8/Pz8/Pz8" +
  "/Pz8/Pz8/Pz8/Pz8/Pz8/Pz8/Pz8/Pz8/Pz8/Pz8/Pz8/Pz8/Pz8/Pz8/Pz8/Pz8/Pz8/Pz8/Pz8/Pz8/Pz8/Pz8/Pz8/Pz8/Pz8" +
  "/Pz8/Pz8/Pz8/Pz8/Pz8/Pz8/Pz8/Pz8/Pz8/Pz8/Pz8/Pz8/Pz8/Pz8/Pz8/Pz8/Pz8/Pz8/Pz8/Pz8/Pz8/Pz8/Pz8/Pz8/Pz8" +
  "/Pz8/Pz8";

const BASE64_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

let cachedGrid: Uint8Array | null = null;

function decodeBase64Bytes(input: string): Uint8Array {
  const lookup = new Int16Array(128).fill(-1);
  for (let i = 0; i < BASE64_ALPHABET.length; i += 1) {
    lookup[BASE64_ALPHABET.charCodeAt(i)] = i;
  }

  const clean = input.replace(/=+$/, "");
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let outIdx = 0;

  for (let i = 0; i < clean.length; i += 4) {
    const c0 = lookup[clean.charCodeAt(i)] ?? 0;
    const c1 = lookup[clean.charCodeAt(i + 1)] ?? 0;
    const hasC2 = i + 2 < clean.length;
    const hasC3 = i + 3 < clean.length;
    const c2 = hasC2 ? (lookup[clean.charCodeAt(i + 2)] ?? 0) : 0;
    const c3 = hasC3 ? (lookup[clean.charCodeAt(i + 3)] ?? 0) : 0;

    out[outIdx++] = (c0 << 2) | (c1 >> 4);
    if (hasC2) {
      out[outIdx++] = ((c1 & 0x0f) << 4) | (c2 >> 2);
    }
    if (hasC3) {
      out[outIdx++] = ((c2 & 0x03) << 6) | c3;
    }
  }
  return out;
}

function getDecodedSurfaceGrid(): Uint8Array {
  if (cachedGrid) return cachedGrid;
  const rle = decodeBase64Bytes(SURFACE_MASK_RLE_BASE64);
  const grid = new Uint8Array(TOTAL_CELLS);
  let pos = 0;
  for (let i = 0; i < rle.length && pos < TOTAL_CELLS; i += 1) {
    const packed = rle[i];
    const value = packed & 0x03;
    const runLen = (packed >> 2) + 1;
    const end = Math.min(TOTAL_CELLS, pos + runLen);
    grid.fill(value, pos, end);
    pos = end;
  }
  cachedGrid = grid;
  return grid;
}

function normalizeLatLng(lat: number, lng: number): { lat: number; lng: number } {
  const clampedLat = Number.isFinite(lat) ? Math.max(-90, Math.min(90, lat)) : 0;
  let wrappedLng = Number.isFinite(lng) ? ((lng + 180) % 360 + 360) % 360 - 180 : 0;
  if (wrappedLng >= 180) wrappedLng = -180;
  return { lat: clampedLat, lng: wrappedLng };
}

/**
 * Classifies a global coordinate into inland_land, inland_lake, coastal_marine, or open_ocean
 * using an embedded isomorphic 0.5° × 0.5° flood-filled Earth surface mask.
 */
export function classifyEarthSurface(
  lat: number,
  lng: number
): EarthSurfaceClassification {
  const norm = normalizeLatLng(lat, lng);
  const gx = Math.min(
    MASK_WIDTH - 1,
    Math.max(0, Math.floor(((norm.lng + 180) / 360) * MASK_WIDTH))
  );
  const gy = Math.min(
    MASK_HEIGHT - 1,
    Math.max(0, Math.floor(((90 - norm.lat) / 180) * MASK_HEIGHT))
  );
  const code = getDecodedSurfaceGrid()[gy * MASK_WIDTH + gx] ?? 0;
  const regime = REGIME_BY_CODE[code] ?? "inland_land";

  return {
    regime,
    hasMarineSurface: regime === "coastal_marine" || regime === "open_ocean",
    hasTerrestrialSurface: regime !== "open_ocean",
    isInlandLake: regime === "inland_lake",
    lat: norm.lat,
    lng: norm.lng,
  };
}

export function isMarineOrCoastalSurface(lat: number, lng: number): boolean {
  return classifyEarthSurface(lat, lng).hasMarineSurface;
}

export function hasTerrestrialSurface(lat: number, lng: number): boolean {
  return classifyEarthSurface(lat, lng).hasTerrestrialSurface;
}

/**
 * Validates whether an Earth Trend Graph dataset domain is physically valid
 * for the given geographic coordinate's planetary surface regime.
 */
export function validateDatasetForSurface(
  dataset: ETGDatasetId,
  lat: number,
  lng: number
): DatasetSurfaceValidation {
  const info = classifyEarthSurface(lat, lng);

  switch (dataset) {
    case "ocean_temp":
      if (!info.hasMarineSurface) {
        return {
          applicable: false,
          regime: info.regime,
          reason: info.isInlandLake
            ? "Inland freshwater lake coordinate — Sea Surface / Marine Temperature (Oceans & Ice) applies only to marine and coastal zones."
            : "Inland continental coordinate — Sea Surface / Marine Temperature (Oceans & Ice) applies only to marine and coastal zones.",
        };
      }
      return { applicable: true, regime: info.regime };

    case "wildfire":
      if (!info.hasTerrestrialSurface) {
        return {
          applicable: false,
          regime: info.regime,
          reason:
            "Open ocean coordinate — terrestrial Wildfire & Vapor Pressure Deficit telemetry applies only to land and coastal zones.",
        };
      }
      return { applicable: true, regime: info.regime };

    case "deforestation":
      if (!info.hasTerrestrialSurface) {
        return {
          applicable: false,
          regime: info.regime,
          reason:
            "Open ocean coordinate — terrestrial Canopy Flux & Vegetation (NDVI) telemetry applies only to land and coastal zones.",
        };
      }
      return { applicable: true, regime: info.regime };

    case "hydrology":
      if (!info.hasTerrestrialSurface) {
        return {
          applicable: false,
          regime: info.regime,
          reason:
            "Open ocean coordinate — terrestrial River Flow & Soil Moisture telemetry applies only to land and coastal zones.",
        };
      }
      return { applicable: true, regime: info.regime };

    case "nasa_power":
    case "air_quality":
    case "community":
    default:
      return { applicable: true, regime: info.regime };
  }
}
